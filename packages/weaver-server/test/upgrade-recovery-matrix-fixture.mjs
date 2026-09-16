import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_CATALOG_REFERENCE,
  canonicalInternalJson,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { createBuiltinProviderFactories } from "../src/bootstrap/provider-resources.ts";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";
import { durableReplace } from "./upgrade-final-matrix-fixture.mjs";

const sourceSchema = objectSchema({ keep: { type: "boolean" } });
const targetSchema = objectSchema({
  keep: { type: "boolean" },
  added: { type: "string", default: "planned" },
});

export const crashRows = [
  { name: "prepared", fault: "applying", initial: "prepared" },
  { name: "intent", fault: "intent", initial: "applying" },
  { name: "predata", fault: "data", initial: "applying" },
  { name: "postdata", fault: "data", mode: "commit-then-reject", initial: "applying" },
  { name: "precomplete", fault: "verifying", initial: "applying" },
  { name: "verifying", fault: "activation-intent", initial: "verifying" },
  { name: "activation", fault: "activation-completion", initial: "verifying" },
];

export async function withCrashRuntime(t, row, operation) {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  const effects = createMatrixEffects();
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, {
      credentials: fixture.credentials,
      factories: effects.factories,
    });
    runtime = await open(fixture, effects);
    assert.equal(
      (await runtime.configService.set("platform", "svc.keep", true)).success,
      true,
    );
    const checkpoint = effects.checkpoint();
    effects.arm(row.fault, row.mode ?? "reject");
    await operation({
      fixture,
      runtime,
      request: planRequest(runtime, fixture.request, row.target),
      effects,
      checkpoint,
      reopen: async (beforeOpen) => {
        await runtime.close().catch(() => undefined);
        await beforeOpen?.();
        runtime = await open(fixture, effects);
        return runtime;
      },
    });
  } finally {
    t.mock.restoreAll();
    await runtime?.close().catch(() => undefined);
    await fixture.dispose();
  }
}

export async function withStaleCheckpoint(t, phase, mutate, operation) {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  const effects = createMatrixEffects();
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, {
      credentials: fixture.credentials,
      factories: effects.factories,
    });
    runtime = await open(fixture, effects);
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const activationPhase = phase === "activation" || phase === "terminal";
    effects.arm(activationPhase ? "activation-completion" : "activation-intent",
      phase === "terminal" ? "commit-then-reject" : "reject");
    await assert.rejects(runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, fixture.request),
    }));
    const state = await rawState(runtime);
    assert.equal(state.journal.phase, phase === "terminal" ? "completed" : "verifying");
    await runtime.close().catch(() => undefined);
    runtime = undefined;
    const path = join(fixture.directory, "control", "entries.json");
    const envelope = JSON.parse(await readFile(path, "utf8"));
    mutate(envelope, state.journal.runId);
    await durableReplace(path, envelope);
    const raw = await readFile(path, "utf8");
    const checkpoint = effects.checkpoint();
    let openError;
    try {
      runtime = await open(fixture, effects);
    } catch (error) {
      openError = error;
    }
    const openAgain = async () => {
      try {
        const candidate = await open(fixture, effects);
        await candidate.close().catch(() => undefined);
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const reopenRuntime = async () => {
      await runtime?.close().catch(() => undefined);
      runtime = await open(fixture, effects);
      return runtime;
    };
    await operation({ runtime, openError, openAgain, reopenRuntime, effects,
      checkpoint, raw, path, runId: state.journal.runId });
  } finally {
    t.mock.restoreAll();
    await runtime?.close().catch(() => undefined);
    await fixture.dispose();
  }
}

export function observeAdmission(t, runtime) {
  const host = hostForControl(runtime.configService);
  const installs = t.mock.method(host, "installUpgradeSnapshot");
  const opens = t.mock.method(host, "openApplication");
  const resumes = t.mock.method(host.maintenance, "resume");
  const events = [];
  let unsubscribe = () => {};
  try {
    unsubscribe = runtime.configService.onDelta((event) => events.push(event));
  } catch (error) {
    assert.equal(error.code, "CONFIG_NOT_READY");
  }
  return {
    snapshot: () => ({
      installs: installs.mock.callCount(),
      opens: opens.mock.callCount(),
      resumes: resumes.mock.callCount(),
      publications: events.length,
    }),
    close: unsubscribe,
  };
}

export async function rawState(runtime) {
  const entries = await Promise.all(
    hostForControl(runtime.configService).providers.map(async (provider) => [
      provider.id,
      await provider.authority.readLayer(provider.layer),
    ]),
  );
  const authorities = Object.fromEntries(entries);
  const journals = Object.values(authorities.control.entries._weaver.upgrades.journal);
  assert.equal(journals.length, 1);
  return { authorities, journal: journals[0] };
}

export function revisionDelta(before, after, providerId) {
  return (
    BigInt(after.authorities[providerId].sequence) -
    BigInt(before.authorities[providerId].sequence)
  );
}

function createMatrixEffects() {
  const state = { records: [], fault: undefined };
  const factories = new Map(
    [...createBuiltinProviderFactories()].map(([id, factory]) => [
      id,
      {
        ...factory,
        create: async (definition, context) => {
          const resource = await factory.create(definition, context);
          wrapProvider(resource.provider, definition.id, state);
          return resource;
        },
      },
    ]),
  );
  return {
    factories,
    arm(kind, mode) {
      state.fault = { kind, mode, fired: false };
    },
    checkpoint: () => state.records.length,
    records: (checkpoint = 0) => state.records.slice(checkpoint),
  };
}

function wrapProvider(provider, providerId, state) {
  if (!provider.authority) return;
  const commit = provider.authority.commitLayer.bind(provider.authority);
  provider.authority.commitLayer = async (request, handle) => {
    const kind = classifyCommit(providerId, request);
    const fault = state.fault;
    if (fault && !fault.fired && fault.kind === kind) {
      fault.fired = true;
      if (fault.mode === "commit-then-reject") {
        const result = await commit(request, handle);
        if (result.success) state.records.push(record(providerId, kind, request));
      }
      return { success: false, error: { code: "WRITE_ERROR", message: "fault" } };
    }
    const result = await commit(request, handle);
    if (result.success) state.records.push(record(providerId, kind, request));
    return result;
  };
}

function record(providerId, kind, request) {
  return { providerId, kind, operationId: request.operationId };
}

function classifyCommit(providerId, request) {
  if (providerId !== "control") return "data";
  const value = request.mutation.action === "set" ? request.mutation.value : undefined;
  if (request.mutation.key.includes(".plans.")) return "plan";
  const journal = journalValue(request.mutation.key, value);
  if (!journal) return "other";
  if (journal.phase === "blocked") return "blocked";
  if (journal.activation?.status === "complete") return "activation-completion";
  if (journal.activation?.status === "intent")
    return request.operationId === journal.activation.operationId
      ? "activation-CAS"
      : "activation-intent";
  if (journal.phase === "prepared") return "prepared";
  if (journal.phase === "verifying") return "verifying";
  if (journal.steps.some((step) => step.status === "intent")) return "intent";
  if (journal.steps.some((step) => step.status === "complete")) return "completion";
  return "applying";
}

function journalValue(key, value) {
  if (key.includes(".journal.")) return value;
  if (key !== "_weaver") return undefined;
  return Object.values(value?.upgrades?.journal ?? {}).at(-1);
}

function planRequest(runtime, initialization, target) {
  const sourceCatalog = catalog(initialization, sourceSchema);
  const targetCatalog = catalog(initialization, targetSchema);
  return {
    version: 1,
    expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(sourceCatalog),
    inventoryRevision: "0",
    infrastructureGeneration: "g1",
    target: {
      catalogDigest: digest(targetCatalog),
      registrations: targetCatalog.registrations,
      ...(target === "builtin" ? { builtinCatalog: BUILTIN_CATALOG_REFERENCE } : {}),
      ...(target === "infrastructure"
        ? { infrastructureGeneration: "g1" }
        : {}),
    },
  };
}

function catalog(initialization, schema) {
  return {
    registrations: Object.fromEntries(
      initialization.registrations.map((request) => {
        const record = initialRegistrationRecord({ ...request, schema });
        return [internalRegistrationId(record), record];
      }),
    ),
  };
}

function objectSchema(properties) {
  return { type: "object", properties, additionalProperties: false };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}

function open(fixture, effects) {
  return openWeaverRuntime(fixture.seed, {
    credentials: fixture.credentials,
    factories: effects.factories,
  });
}
