import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalInternalJson,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import {
  controlProjection,
  controlTransaction,
  hostForControl,
} from "../src/core/config-service-internal.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";
import {
  assertLifecycle,
  assertNoLifecycleLeaks,
  assertNoPublication,
  countingFactories,
  newCounters,
  observeRuntime as observeLifecycle,
} from "./upgrade-compensation-lifecycle.mjs";

export {
  assertLifecycle,
  assertNoLifecycleLeaks,
  assertNoPublication,
  newCounters,
};

export const sourceSchema = {
  type: "object",
  properties: { keep: { type: "boolean" } },
  additionalProperties: false,
};
export const targetSchema = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    added: { type: "string", default: "planned" },
  },
  additionalProperties: false,
};

export async function createAppliedRun(t, counters, multiple = false) {
  const fixture = await createStandaloneFixture({
    schemas: multiple
      ? { svc: sourceSchema, aux: sourceSchema }
      : { svc: sourceSchema },
  });
  await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, {
    credentials: fixture.credentials,
  });
  const runtime = await reopen(fixture, counters);
  const observation = observeRuntime(t, runtime, counters, false);
  for (const serviceId of multiple ? ["svc", "aux"] : ["svc"])
    assert.equal(
      (await runtime.configService.set("platform", `${serviceId}.keep`, true))
        .success,
      true,
    );
  await stopAfterForwardData(t, runtime, fixture.request);
  const runId = runtime.maintenanceStatus().activeRun.runId;
  return {
    fixture,
    runtime,
    runId,
    observation,
    open: true,
    lifecycle: {
      resourcesPerOpen: counters.resourcesCreated,
      providerSubscriptionsPerOpen: counters.providerSubscriptions,
      expectedPublicEvents: counters.publicEvents,
    },
  };
}

export async function closeRunInstance(run, counters) {
  if (!run.open) return;
  run.observation.close();
  await run.runtime.close();
  run.open = false;
  counters.closes++;
  assert.equal(
    counters.providerSubscriptionDisposals,
    counters.providerSubscriptions,
  );
  assert.equal(counters.publicSubscriptionDisposals, counters.publicSubscriptions);
  assert.equal(counters.resourcesDisposed, counters.resourcesCreated);
}

export async function reopenRun(run, t, counters, countWrites = true) {
  run.runtime = await reopen(run.fixture, counters);
  run.observation = observeRuntime(t, run.runtime, counters, countWrites);
  run.open = true;
}

export async function reopen(fixture, counters) {
  if (counters) counters.openAttempts++;
  const runtime = await openWeaverRuntime(fixture.seed, {
    credentials: fixture.credentials,
    ...(counters ? { factories: countingFactories(counters) } : {}),
  });
  if (counters) counters.opens++;
  return runtime;
}

async function stopAfterForwardData(t, runtime, initialization) {
  const control = provider(runtime, "control");
  const commit = control.authority.commitLayer.bind(control.authority);
  let failed = false;
  const fault = t.mock.method(
    control.authority,
    "commitLayer",
    async (request, handle) => {
      if (
        !failed &&
        request.mutation.action === "set" &&
        request.mutation.value?.phase === "verifying"
      ) {
        failed = true;
        return {
          success: false,
          error: { code: "WRITE_ERROR", message: "verification-secret" },
        };
      }
      return commit(request, handle);
    },
  );
  await assert.rejects(
    runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    }),
  );
  fault.mock.restore();
}

export function installCrash(t, runtime, boundary, counters) {
  const platform = provider(runtime, "platform");
  const control = provider(runtime, "control");
  const dataCommit = platform.authority.commitLayer.bind(platform.authority);
  const journalCommit = control.authority.commitLayer.bind(control.authority);
  let crashed = false;
  const dataMock = t.mock.method(platform.authority, "commitLayer", async (request, handle) => {
    if (boundary === "after-intent") return crashBeforeWrite();
    const result = await dataCommit(request, handle);
    recordReverse(result, request, counters);
    if (boundary === "after-data") return crashAfterWrite();
    return result;
  });
  const controlMock = t.mock.method(control.authority, "commitLayer", async (request, handle) => {
    const kind = journalKind(request);
    if (crashed) throw new Error("simulated process crash");
    if (boundary === "before-intent" && kind === "intent")
      return crashBeforeWrite();
    const result = await journalCommit(request, handle);
    recordJournal(result, request, counters);
    if (boundary === "after-complete" && kind === "completion")
      return crashAfterWrite();
    return result;
  });
  function crashBeforeWrite() {
    crashed = true;
    throw new Error("simulated process crash before durable write");
  }
  function crashAfterWrite() {
    crashed = true;
    throw new Error("simulated acknowledgement loss after durable write");
  }
  return () => {
    dataMock.mock.restore();
    controlMock.mock.restore();
  };
}

function observeRuntime(t, runtime, counters, countWrites = true) {
  return observeLifecycle(
    t,
    runtime,
    counters,
    countWrites ? (item, result, request) => recordRuntimeWrite(item, result, request, counters) : undefined,
  );
}

function recordRuntimeWrite(item, result, request, counters) {
  if (item.id === "platform") recordReverse(result, request, counters);
  if (item.id === "control") recordJournal(result, request, counters);
}

export async function durableSequences(runtime) {
  const platform = await provider(runtime, "platform").authority.readLayer(
    "platform",
  );
  const control = await provider(runtime, "control").authority.readLayer(
    "control",
  );
  return { platform: BigInt(platform.sequence), control: BigInt(control.sequence) };
}

export function recoveryJournal(runtime, runId) {
  return controlProjection(runtime.configService).prepared().configuration.upgrades
    .journal[runId];
}

export async function persistJournalCorruption(runtime, runId, mutate) {
  const changed = structuredClone(await rawJournal(runtime, runId));
  const control = provider(runtime, "control");
  const envelope = await control.authority.readLayer(control.layer);
  const operationId = randomUUID();
  changed.control.receipts.push(envelope.lastCommit);
  changed.control.operationId = operationId;
  changed.cursor = changed.cursor.map((entry) =>
    entry.providerId === control.id
      ? { providerId: control.id, revision: envelope.lastCommit.revision }
      : entry,
  );
  mutate(changed);
  const result = await durableCommit(
    runtime,
    control,
    `_weaver.upgrades.journal.${runId}`,
    changed,
    false,
    operationId,
  );
  assert.equal(result.success, true);
  const durable = await rawJournal(runtime, runId);
  assert.deepEqual(durable, changed);
  return changed;
}

export async function persistDataCorruption(runtime, kind, journal) {
  const platform = provider(runtime, "platform");
  const step = journal.steps[0];
  const operationId = step.compensation.operationId;
  if (kind === "digest") {
    const result = await durableCommit(
      runtime,
      platform,
      "svc.added",
      undefined,
      true,
      operationId,
    );
    assert.equal(result.success, true);
  } else if (kind === "receipt") {
    assert.equal(
      (await durableCommit(runtime, platform, "svc", { keep: true }, false, operationId))
        .success,
      true,
    );
    const result = await durableCommit(runtime, platform, "svc", { keep: true });
    assert.equal(result.success, true);
  } else {
    const value = dataCorruptionValue(kind);
    const result = await durableCommit(runtime, platform, "svc", value);
    assert.equal(result.success, true);
  }
  return platform.authority.readLayer("platform");
}

function dataCorruptionValue(kind) {
  if (kind === "state") return { keep: false };
  if (kind === "revision" || kind === "cursor")
    return { keep: true, added: "planned" };
  return { keep: true };
}

export async function persistCompensationIntent(runtime, runId, counters) {
  const journal = structuredClone(await rawJournal(runtime, runId));
  const operationId = randomUUID();
  const journalOperationId = randomUUID();
  const control = provider(runtime, "control");
  const envelope = await control.authority.readLayer(control.layer);
  journal.control.receipts.push(envelope.lastCommit);
  journal.control.operationId = journalOperationId;
  journal.cursor = journal.cursor.map((entry) =>
    entry.providerId === control.id
      ? { providerId: control.id, revision: envelope.lastCommit.revision }
      : entry,
  );
  journal.phase = "compensating";
  journal.steps[journal.steps.length - 1].compensation = {
    status: "intent",
    operationId,
  };
  const result = await controlTransaction(
    runtime.configService,
    "maintenance",
    ({ write }) =>
      write(`_weaver.upgrades.journal.${runId}`, journal, {
        expectedRevision: runtime.configService.revision,
        operationId: journalOperationId,
      }),
  );
  assert.equal(result.success, true);
  counters.intents.add(operationId);
  assert.deepEqual(await rawJournal(runtime, runId), journal);
  return journal;
}

export async function rawJournal(runtime, runId) {
  const envelope = await provider(runtime, "control").authority.readLayer("control");
  return envelope.entries._weaver.upgrades.journal[runId];
}

export function provider(runtime, id) {
  const found = runtime.configService.providers.find((item) => item.id === id);
  assert.ok(found?.authority);
  return found;
}

export function compensate(runtime, runId) {
  return runtime.recoverUpgrade({
    version: 1,
    runId,
    action: "compensate",
    priorOwnerStopped: {
      observedAt: new Date().toISOString(),
      evidence: "prior filesystem-backed runtime closed",
    },
  });
}

function recordReverse(result, request, counters) {
  if (!result.success) return;
  counters.reverseEffects++;
  counters.reverseOrder.push(request.mutation.key);
}

function recordJournal(result, request, counters) {
  if (!result.success) return;
  const value = request.mutation.action === "set" ? request.mutation.value : null;
  if (!value?.steps) return;
  const compensation = value.steps.find((step) => step.compensation)?.compensation;
  if (compensation?.status === "complete") {
    counters.completions.add(compensation.operationId);
    return;
  }
  if (
    compensation?.status === "intent" &&
    !counters.intents.has(compensation.operationId)
  ) {
    counters.intents.add(compensation.operationId);
    return;
  }
  counters.otherJournal.add(request.operationId);
}

function journalKind(request) {
  const value = request.mutation.action === "set" ? request.mutation.value : null;
  if (!value?.steps) return undefined;
  const compensation = value.steps.find((step) => step.compensation)?.compensation;
  if (value.phase === "compensating" && compensation?.status === "intent")
    return "intent";
  if (compensation?.status === "complete") return "completion";
  return "other";
}

async function durableCommit(runtime, target, key, value, remove = false, operationId) {
  const host = hostForControl(runtime.configService);
  const { result } = await host.authority.commit(
    target,
    target.layer,
    key,
    value,
    remove,
    operationId,
  );
  return result;
}

function planRequest(runtime, initialization) {
  const sourceCatalog = {
    registrations: records(initialization.registrations, (request) =>
      initialRegistrationRecord(request),
    ),
  };
  const targetCatalog = {
    registrations: records(initialization.registrations, (request) => ({
      version: 1,
      kind: "service",
      request: { ...request, schema: targetSchema },
      audit: { actor: "planner" },
    })),
  };
  return {
    version: 1,
    expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(sourceCatalog),
    inventoryRevision: "0",
    infrastructureGeneration: "g1",
    target: {
      catalogDigest: digest(targetCatalog),
      registrations: targetCatalog.registrations,
    },
  };
}

function records(registrations, create) {
  return Object.fromEntries(
    registrations.map((request) => {
      const record = create(request);
      return [internalRegistrationId(record), record];
    }),
  );
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
