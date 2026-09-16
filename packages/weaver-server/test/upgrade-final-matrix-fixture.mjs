import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalInternalJson, internalRegistrationId } from "@weaver-conf/config-types";
import { createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";
import { scopeContextId } from "../src/core/scope-inventory.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";
import {
  createProviderEffectObserver,
  durableFileSnapshot,
  assertSanitizedSurfaces,
} from "./upgrade-final-effect-proof.mjs";
export { assertSanitizedSurfaces, durableFileSnapshot };

export const regionUs = [{ scopeId: "region", value: "us" }];
export const regionEu = [{ scopeId: "region", value: "eu" }];
export const tenantOne = [...regionUs, { scopeId: "tenant", value: "one" }];
export const tenantTwo = [...regionUs, { scopeId: "tenant", value: "two" }];

const sourceSchema = objectSchema({
  marker: { type: "string" }, source: { type: "string" },
}, ["marker"]);
const targetSchema = objectSchema({
  marker: { type: "string" }, source: { type: "string" },
  port: { type: "integer", default: 41 },
}, ["marker"]);

export async function withFinalMatrixRuntime(t, operation, options = {}) {
  const fixture = await createStandaloneFixture({
    schemas: { svc: sourceSchema },
    paths: [regionUs, tenantOne, tenantTwo],
    retired: [regionEu],
  });
  let runtime;
  let primaryClosed = false;
  const providerEffects = createProviderEffectObserver();
  try {
    await initializeWeaver(
      fixture.seed,
      fixture.request,
      fixture.administrator,
      { credentials: fixture.credentials, factories: providerEffects.factories },
    );
    await seedDurableScopes(fixture.directory, options.values);
    const runtimeOptions = {
      credentials: fixture.credentials,
      factories: providerEffects.factories,
      ...(options.secretBackend ? { secretBackend: options.secretBackend } : {}),
    };
    runtime = await openWeaverRuntime(fixture.seed, runtimeOptions);
    await seedContextMarkers(runtime, options.values?.base);
    await runtime.configService.flush();
    await operation({
      fixture,
      runtime,
      request: planRequest(runtime, fixture.request),
      providerEffects,
      effectCheckpoint: providerEffects.checkpoint(),
      reopen: async () => {
        if (!primaryClosed) {
          primaryClosed = true;
          try {
            await runtime.close();
          } catch (error) {
            assert.equal(error.code, "COMMIT_OUTCOME_UNKNOWN");
            assert.equal(error.message, "Invalid built-in value at /_weaver");
          }
        }
        return openWeaverRuntime(fixture.seed, runtimeOptions);
      },
    });
  } finally {
    t.mock.restoreAll();
    if (!primaryClosed && runtime) {
      try {
        await runtime.close();
      } catch (error) {
        assert.equal(error.code, "COMMIT_OUTCOME_UNKNOWN");
        assert.equal(error.message, "Invalid built-in value at /_weaver");
      }
    }
    await fixture.dispose();
  }
}

export function armFinalValidation(t, runtime, arm) {
  const host = hostForControl(runtime.configService);
  const validate = host.pipeline.validate.bind(host.pipeline);
  t.mock.method(host.pipeline, "validate", async (...arguments_) => {
    if (!arguments_[2]) return validate(...arguments_);
    arm();
    return validate(...arguments_);
  });
}

export function interceptFinalBoundary(t, runtime, action) {
  const host = hostForControl(runtime.configService);
  const validate = host.pipeline.validate.bind(host.pipeline);
  let injected = false;
  t.mock.method(host.pipeline, "validate", async (...arguments_) => {
    if (arguments_[2] && !injected) {
      injected = true;
      await action();
    }
    return validate(...arguments_);
  });
}

export function mutateFinalContextRequest(t, runtime, mutate) {
  const host = hostForControl(runtime.configService);
  const validate = host.pipeline.validate.bind(host.pipeline);
  t.mock.method(host.pipeline, "validate", (...arguments_) => {
    if (!arguments_[2]) return validate(...arguments_);
    const changed = structuredClone(arguments_[2]);
    mutate(changed);
    return validate(arguments_[0], arguments_[1], changed);
  });
}

export function observeNoAdmission(t, runtime) {
  const host = hostForControl(runtime.configService);
  const events = [];
  let unsubscribe = () => {};
  try {
    unsubscribe = runtime.configService.onDelta((event) => events.push(event));
  } catch (error) {
    assert.equal(error.code, "CONFIG_NOT_READY");
  }
  const subscriptions = hostForControl(runtime.configService).providers.flatMap((item) =>
    item.onExternalChange ? [t.mock.method(item, "onExternalChange")] : []);
  const install = t.mock.method(host, "installUpgradeSnapshot");
  const open = t.mock.method(host, "openApplication");
  const resume = t.mock.method(host.maintenance, "resume");
  return {
    assertNone() {
      assert.equal(install.mock.callCount(), 0);
      assert.equal(open.mock.callCount(), 0);
      assert.equal(resume.mock.callCount(), 0);
      assert.equal(events.length, 0);
      assert.equal(subscriptions.reduce(
        (count, item) => count + item.mock.callCount(), 0), 0);
    },
    close: unsubscribe,
  };
}

export function assertExactPreparedEffects(before, after, journal) {
  const steps = journal.steps.length;
  assert.equal(revisionDelta(before.control, after.control), BigInt(4 + 2 * steps));
  assert.equal(applicationRevisionDelta(before.application, after.application), BigInt(steps));
  assert.ok(journal.steps.every((step) => step.status === "complete"));
  assert.ok(journal.steps.every((step) => step.receipt.operationId === step.operationId));
  assert.equal(journal.activation.status, "pending");
  return {
    plan: 1,
    journalPreparation: 3 + 2 * steps,
    forwardData: steps,
    activationIntent: 0,
    activationCas: 0,
    activationCompletion: 0,
    failureJournal: 0,
  };
}

export async function captureExpectedFailure(pending, code, message) {
  try {
    await (typeof pending === "function" ? pending() : pending);
    assert.fail("operation unexpectedly succeeded");
  } catch (error) {
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return error;
  }
}

export function corruptActivationIntent(t, runtime, mutate) {
  return corruptIntentJournal(t, runtime, (journal) =>
    mutate(journal.activation.finalContexts),
  );
}

export function corruptIntentJournal(t, runtime, mutate) {
  const control = hostForControl(runtime.configService).providers.find((item) => item.id === "control");
  assert.ok(control?.authority);
  const commit = control.authority.commitLayer.bind(control.authority);
  let corrupted = false;
  t.mock.method(control.authority, "commitLayer", async (request, handle) => {
    const journal = intentJournal(request);
    if (journal && !corrupted) {
      mutate(journal);
      corrupted = true;
    }
    return commit(request, handle);
  });
  return () => assert.equal(corrupted, true);
}

function intentJournal(request) {
  if (request.mutation.action !== "set" || request.mutation.key !== "_weaver")
    return undefined;
  return Object.values(request.mutation.value.upgrades?.journal ?? {}).find(
    (journal) => journal.activation?.status === "intent",
  );
}

export async function assertPreactivationRefusal(
  runtime,
  execution,
  effects,
  initial,
  reopen,
  fixture,
) {
  const failure = await captureExpectedFailure(
    execution,
    "REVISION_CONFLICT",
    "Upgrade plan is no longer current",
  );
  const beforeRecovery = await authoritySnapshot(runtime);
  const journal = onlyJournal(beforeRecovery.control);
  assert.equal(journal.activation.status, "pending");
  assert.equal(journal.phase, "verifying");
  if (initial) assertExactPreparedEffects(initial, beforeRecovery, journal);
  assertNonready(runtime);
  assertSanitized(runtime.maintenanceStatus());
  effects.assertNone();
  await assertSanitizedSurfaces(runtime, failure);
  effects.close();
  const durableBefore = await durableFileSnapshot(fixture);
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await reopen();
    try {
      await captureExpectedFailure(
        fresh.recoverUpgrade({ version: 1, runId: journal.runId }),
        "FORBIDDEN",
        "Upgrade ownership could not be established",
      );
      assertNonready(fresh);
    } finally {
      await fresh.close();
    }
  }
  assert.deepEqual(await durableFileSnapshot(fixture), durableBefore);
}

export async function authoritySnapshot(runtime) {
  const entries = await Promise.all(
    hostForControl(runtime.configService).providers.map(async (provider) => [
      provider.id,
      await Promise.all(
        (await provider.authority.inventory()).revisions.map((revision) =>
          provider.authority.readLayer(revision.layer),
        ),
      ),
    ]),
  );
  return {
    control: entries.find(([id]) => id === "control")[1][0],
    application: Object.fromEntries(entries.filter(([id]) => id !== "control")),
  };
}

export function onlyJournal(control) {
  const journals = Object.values(control.entries._weaver.upgrades.journal);
  assert.equal(journals.length, 1);
  return journals[0];
}

function assertNonready(runtime) {
  assert.notEqual(runtime.state, "ready");
  assert.equal(runtime.maintenanceStatus().ready, false);
}

function assertSanitized(value) {
  return assertSanitizedValue(value, []);
}

function assertSanitizedValue(value, extra) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["finalContexts", "aggregateDigest", "storeId", "sequence",
    "journal", "receipt", "revision", "mongodb://", "/tmp/", ...extra])
    assert.equal(serialized.includes(forbidden), false, forbidden);
}

function revisionDelta(before, after) {
  return BigInt(after.sequence) - BigInt(before.sequence);
}

function applicationRevisionDelta(before, after) {
  let total = 0n;
  for (const [providerId, envelopes] of Object.entries(after)) {
    const previous = before[providerId];
    for (const envelope of envelopes) {
      const prior = previous.find((item) => item.layer === envelope.layer);
      total += revisionDelta(prior, envelope);
    }
  }
  return total;
}

async function seedContextMarkers(runtime, value = { marker: "marker-base" }) {
  await requireWrite(runtime.configService.set("platform", "svc", value));
}

async function seedDurableScopes(directory, values = {}) {
  const defaults = {
    "region:us": { marker: "marker-active" },
    "region:eu": { marker: "marker-retired" },
    "tenant:one": { marker: "marker-multiscope" },
    "tenant:two": { marker: "marker-cold" },
  };
  for (const [providerId, layers] of [["region", ["region:eu", "region:us"]],
    ["tenant", ["tenant:one", "tenant:two"]]]) {
    const provider = createFileSystemStorageProvider({
      id: `setup-${providerId}`,
      layer: providerId,
      filePath: join(directory, providerId, "entries.json"),
      writable: true,
      authority: { environment: "dev", initialize: false, layers },
    });
    for (const layer of layers) {
      const value = values[layer] ?? defaults[layer];
      assert.equal((await provider.writeLayer(layer, "svc", value)).success, true);
    }
  }
}

export async function durableReplace(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function requireWrite(pending) {
  assert.equal((await pending).success, true);
}

function planRequest(runtime, initialization) {
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

function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
