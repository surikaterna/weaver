import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUILTIN_CATALOG_REFERENCE,
  canonicalInternalJson,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { activationCompletionOperationId } from "../src/core/activation-completion-operation.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";

const sourceSchema = objectSchema({ keep: { type: "boolean" } });
const targetSchema = objectSchema({
  keep: { type: "boolean" },
  added: { type: "string", default: "planned" },
});
const boundaries = [
  ["after-validation", "before-intent"],
  ["after-intent", "after-intent"],
  ["after-activation", "after-activation"],
  ["final-read", "final-read"],
];

for (const [name, boundary] of boundaries)
  test(`durable application boundary ${name} is fenced`, async (t) => {
    await withRuntime(t, async ({ runtime, initialization, directory }) => {
      await writeSource(runtime);
      const host = hostForControl(runtime.configService);
      const platform = provider(runtime, "platform");
      const control = provider(runtime, "control");
      const before = await rawAuthorities(platform, control);
      const effects = observeEffects(t, runtime);
      const race = installRace(t, {
        boundary,
        runtime,
        host,
        platform,
        control,
        directory,
        effects,
      });
      const execution = runtime.applyUpgrade({
        version: 1,
        request: planRequest(runtime, initialization),
      });
      if (boundary === "final-read")
        assert.equal((await execution).status, "completed");
      else await assert.rejects(execution);
      const rejected = await rawAuthorities(platform, control);
      assertDurableRace(boundary, before, rejected, race);
      assertExactEffects(boundary, effects.snapshot());
      if (boundary === "final-read")
        await assertCompletedRecoveryIsEffectFree(runtime, rejected, effects);
      else {
        await assertNonready(runtime);
        await assertRejectedRecoveryIsEffectFree(runtime, rejected, effects);
      }
      effects.close();
    });
  });

function installRace(t, fixture) {
  const state = {
    injected: undefined,
    attempt: undefined,
    postCompleteReads: 0,
    postCompleteControlReads: 0,
  };
  wrapCommits(t, fixture, state);
  if (fixture.boundary === "final-read") wrapFinalRead(t, fixture, state);
  return state;
}

function wrapCommits(t, fixture, state) {
  for (const candidate of fixture.runtime.configService.providers) {
    const commit = candidate.authority.commitLayer.bind(candidate.authority);
    t.mock.method(candidate.authority, "commitLayer", async (request, handle) => {
      const kind = commitKind(candidate.id, request);
      fixture.effects.record(candidate.id, kind, request.operationId);
      if (fixture.boundary === "before-intent" && kind === "intent")
        state.injected = await commitExternalData(fixture);
      const result = await commit(request, handle);
      if (!result.success) return result;
      if (kind === "completion") fixture.effects.markCompleted();
      if (
        ((fixture.boundary === "after-intent" && kind === "intent") ||
          fixture.boundary === kind) &&
        !state.injected
      )
        state.injected = await commitExternalData(fixture);
      return result;
    });
  }
}

function wrapFinalRead(t, fixture, state) {
  let releaseControlRead;
  const controlReadComplete = new Promise((resolve) => {
    releaseControlRead = resolve;
  });
  const readControl = fixture.control.authority.readLayer.bind(
    fixture.control.authority,
  );
  t.mock.method(fixture.control.authority, "readLayer", async (layer) => {
    const envelope = await readControl(layer);
    if (fixture.effects.completed() && ++state.postCompleteControlReads === 4)
      releaseControlRead();
    return envelope;
  });
  const readPlatform = fixture.platform.authority.readLayer.bind(
    fixture.platform.authority,
  );
  t.mock.method(fixture.platform.authority, "readLayer", async (layer) => {
    const envelope = await readPlatform(layer);
    if (!fixture.effects.completed()) return envelope;
    state.postCompleteReads++;
    if (state.postCompleteReads === 2) {
      await controlReadComplete;
      state.attempt = {
        ...(await attemptCompetingWrite(fixture.directory)),
        atRead: state.postCompleteReads,
      };
    }
    return envelope;
  });
}

async function commitExternalData({ host, platform, boundary }) {
  const operationId = operationIdFor(boundary);
  const before = await platform.authority.readLayer(platform.layer);
  const committed = await host.authority.commit(
    platform,
    platform.layer,
    "svc.keep",
    false,
    false,
    operationId,
  );
  assert.equal(committed.result.success, true);
  const after = await platform.authority.readLayer(platform.layer);
  return { operationId, before, after };
}

async function attemptCompetingWrite(directory) {
  const competing = createFileSystemStorageProvider({
    id: "competing-platform",
    layer: "platform",
    filePath: join(directory, "platform", "entries.json"),
    writable: true,
    authority: { environment: "dev", initialize: false },
  });
  const before = await competing.authority.readLayer("platform");
  const result = await competing.write("svc.keep", false);
  const after = await competing.authority.readLayer("platform");
  return { before, result, after };
}

function assertDurableRace(boundary, before, after, race) {
  if (boundary === "final-read") {
    assert.equal(race.attempt.atRead, 2);
    assert.equal(race.attempt.result.success, false);
    assert.equal(race.attempt.result.error?.code, "WRITER_CONFLICT");
    assert.deepEqual(race.attempt.after, race.attempt.before);
    assert.deepEqual(after.platform, race.attempt.before);
  } else {
    assert.equal(race.injected.operationId, operationIdFor(boundary));
    assert.equal(race.injected.after.entries.svc.keep, false);
    assert.equal(race.injected.after.lastCommit.operationId, race.injected.operationId);
    assertRevisionAdvance(race.injected.before, race.injected.after, 1n);
    assert.deepEqual(after.platform, race.injected.after);
  }
  assert.deepEqual(after.platform.entries, {
    svc: {
      keep: boundary === "final-read",
      added: "planned",
    },
  });
  assertRevisionAdvance(before.platform, after.platform, boundary === "final-read" ? 1n : 2n);
  const expectedControlCommits = isEarly(boundary) ? 7n : 9n;
  assertRevisionAdvance(before.control, after.control, expectedControlCommits);
  const journals = Object.values(after.control.entries._weaver.upgrades.journal);
  assert.equal(journals.length, 1);
  assertJournalEvidence(boundary, journals[0], after);
}

function assertJournalEvidence(boundary, journal, authorities) {
  assert.equal(journal.steps.length, 1);
  assert.equal(journal.steps[0].status, "complete");
  assert.equal(journal.activation.status, isEarly(boundary) ? "intent" : "complete");
  if (boundary === "final-read") {
    assert.deepEqual(journal.steps[0].receipt.revision, revision(authorities.platform));
    assert.equal(authorities.platform.lastCommit.operationId, journal.steps[0].operationId);
  } else
    assert.deepEqual(
      journal.steps[0].receipt.revision,
      authorities.platform.lastCommit.previousRevision,
    );
  if (isEarly(boundary)) return;
  assert.equal(journal.activation.receipt.operationId, journal.activation.operationId);
  assert.equal(
    authorities.control.lastCommit.operationId,
    activationCompletionOperationId(journal.runId),
  );
  assert.deepEqual(
    authorities.control.lastCommit.previousRevision,
    journal.activation.receipt.revision,
  );
}

function assertExactEffects(boundary, effects) {
  assert.deepEqual(effects.commits, {
    control: { other: 6, intent: 1, activation: isEarly(boundary) ? 0 : 1,
      completion: isEarly(boundary) ? 0 : 1 },
    platform: { planned: 1, external: boundary === "final-read" ? 0 : 1 },
  });
  assert.deepEqual(effects.admission, {
    installs: boundary === "final-read" ? 1 : 0,
    opens: boundary === "final-read" ? 1 : 0,
    resumes: boundary === "final-read" ? 1 : 0,
    events: 0,
    configSubscriptions: 0,
    providerSubscriptions: 0,
  });
}

async function assertRejectedRecoveryIsEffectFree(runtime, rejected, effects) {
  const runId = Object.keys(rejected.control.entries._weaver.upgrades.journal)[0];
  const before = effects.snapshot();
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(runtime.recoverUpgrade({ version: 1, runId }));
  assert.deepEqual(effects.snapshot(), before);
  const after = await rawAuthorities(provider(runtime, "platform"), provider(runtime, "control"));
  assert.deepEqual(after, rejected);
  await assertNonready(runtime);
}

async function assertCompletedRecoveryIsEffectFree(runtime, completed, effects) {
  const runId = Object.keys(completed.control.entries._weaver.upgrades.journal)[0];
  const before = effects.snapshot();
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal((await runtime.recoverUpgrade({ version: 1, runId })).status, "completed");
  assert.deepEqual(effects.snapshot(), before);
  const after = await rawAuthorities(provider(runtime, "platform"), provider(runtime, "control"));
  assert.deepEqual(after, completed);
  assert.equal(runtime.state, "ready");
  assert.deepEqual(await runtime.configService.get("svc"), { keep: true, added: "planned" });
}

async function assertNonready(runtime) {
  assert.notEqual(runtime.state, "ready");
  assert.equal(runtime.maintenanceStatus().ready, false);
  await assert.rejects(runtime.configService.get("svc"), { code: "MAINTENANCE" });
}

function observeEffects(t, runtime) {
  const host = hostForControl(runtime.configService);
  const events = [];
  const unsubscribe = runtime.configService.onDelta((event) => events.push(event));
  const records = [];
  let completionCommitted = false;
  const install = t.mock.method(host, "installUpgradeSnapshot");
  const open = t.mock.method(host, "openApplication");
  const resume = t.mock.method(host.maintenance, "resume");
  const subscriptions = t.mock.method(runtime.configService, "onDelta");
  const providerSubscriptions = runtime.configService.providers.flatMap((item) =>
    item.onExternalChange ? [t.mock.method(item, "onExternalChange")] : [],
  );
  return {
    record: (providerId, kind, operationId) => records.push({ providerId, kind, operationId }),
    markCompleted: () => {
      completionCommitted = true;
    },
    completed: () => completionCommitted,
    snapshot: () => effectSnapshot(records, events, install, open, resume,
      subscriptions, providerSubscriptions),
    close: unsubscribe,
  };
}

function effectSnapshot(records, events, install, open, resume, subscriptions, providerSubscriptions) {
  const count = (providerId, kind) =>
    records.filter((item) => item.providerId === providerId && item.kind === kind).length;
  return {
    commits: {
      control: { other: count("control", "other"), intent: count("control", "intent"),
        activation: count("control", "after-activation"), completion: count("control", "completion") },
      platform: { planned: count("platform", "planned"),
        external: count("platform", "external") },
    },
    admission: { installs: install.mock.callCount(), opens: open.mock.callCount(),
      resumes: resume.mock.callCount(), events: events.length,
      configSubscriptions: subscriptions.mock.callCount(),
      providerSubscriptions: providerSubscriptions.reduce((sum, item) => sum + item.mock.callCount(), 0) },
  };
}

function commitKind(providerId, request) {
  if (providerId !== "control")
    return request.operationId.startsWith("00000000-0000-4000-8000-00000000010")
      ? "external"
      : "planned";
  const value = request.mutation.action === "set" ? request.mutation.value : undefined;
  const journal = value?.activation
    ? value
    : request.mutation.key === "_weaver"
      ? Object.values(value.upgrades.journal)
        .filter((item) => item.activation.status !== "pending").at(-1)
      : undefined;
  const activation = journal?.activation;
  if (activation?.status === "complete") return "completion";
  if (activation?.status !== "intent") return "other";
  return request.operationId === activation.operationId ? "after-activation" : "intent";
}

async function rawAuthorities(platform, control) {
  return {
    platform: await platform.authority.readLayer(platform.layer),
    control: await control.authority.readLayer(control.layer),
  };
}

function assertRevisionAdvance(before, after, count) {
  assert.equal(after.storeId, before.storeId);
  assert.equal(after.environment, before.environment);
  assert.equal(after.layer, before.layer);
  assert.equal(after.epoch, before.epoch);
  assert.equal(BigInt(after.sequence), BigInt(before.sequence) + count);
}

function revision(envelope) {
  const { storeId, environment, layer, epoch, sequence } = envelope;
  return { storeId, environment, layer, epoch, sequence };
}

async function withRuntime(t, operation) {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator,
      { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    await operation({ runtime, initialization: fixture.request, directory: fixture.directory });
    await runtime.close();
    runtime = undefined;
  } finally {
    t.mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
}

function planRequest(runtime, initialization) {
  const sourceCatalog = { registrations: Object.fromEntries(
    initialization.registrations.map((request) => {
      const record = initialRegistrationRecord(request);
      return [internalRegistrationId(record), record];
    }),
  ) };
  const record = { version: 1, kind: "service",
    request: { ...initialization.registrations[0], schema: targetSchema },
    audit: { actor: "planner" } };
  const targetCatalog = { registrations: { [internalRegistrationId(record)]: record } };
  return { version: 1, expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(sourceCatalog), inventoryRevision: "0",
    infrastructureGeneration: "g1",
    target: { catalogDigest: digest(targetCatalog), registrations: targetCatalog.registrations } };
}

function provider(runtime, id) {
  const result = runtime.configService.providers.find((item) => item.id === id);
  assert.ok(result?.authority);
  return result;
}

async function writeSource(runtime) {
  assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
}

function operationIdFor(boundary) {
  const index = ["before-intent", "after-intent", "after-activation"].indexOf(boundary) + 1;
  return `00000000-0000-4000-8000-00000000010${index}`;
}

function isEarly(boundary) {
  return boundary === "before-intent" || boundary === "after-intent";
}

function objectSchema(properties) {
  return { type: "object", properties, additionalProperties: false };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
