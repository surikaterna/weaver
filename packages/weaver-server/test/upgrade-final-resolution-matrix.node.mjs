import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeaverError } from "@weaver-conf/config-types";
import {
  prepareDurableFinalFailure,
  runDurableFinalValidation,
} from "./upgrade-final-durable-state.mjs";
import {
  assertExactPreparedEffects,
  assertSanitizedSurfaces,
  authoritySnapshot,
  captureExpectedFailure,
  durableFileSnapshot,
  observeNoAdmission,
  withFinalMatrixRuntime,
} from "./upgrade-final-matrix-fixture.mjs";

const contextRows = [
  ["base", "base"],
  ["active", "region:us"],
  ["retired", "region:eu"],
  ["cold", "tenant:two"],
];

for (const [name, target] of contextRows)
  test(`durable final validation rejects invalid resolved ${name} context`, async (t) => {
    await runResolutionRow(t, target, "invalid");
  });

for (const [name, mode] of [
  ["mount", "unresolved-mount"],
  ["mount cycle", "mount-cycle"],
  ["SecretReference", "unresolved-secret"],
  ["SecretReference without backend", "missing-backend"],
])
  test(`durable final validation rejects unresolved ${name}`, async (t) => {
    await runResolutionRow(t, "base", mode);
  });

async function runResolutionRow(t, target, mode) {
  const uri = `u5d/${target}/${mode}`;
  const state = { armed: false };
  const secretBackend = {
    resolve: async ({ uri: candidate }) => resolveSecret(state, mode, uri, candidate),
  };
  await withFinalMatrixRuntime(t, (fixture) =>
    executeResolutionRow(t, fixture, target, mode, uri, state), { secretBackend });
}

async function executeResolutionRow(t, resources, target, mode, uri, state) {
  const { fixture, runtime, request, reopen } = resources;
  const effects = observeNoAdmission(t, runtime);
  const initial = await authoritySnapshot(runtime);
  const value = durableValue(mode, uri);
  const prepared = await prepareDurableFinalFailure(
    fixture,
    runtime,
    request,
    target,
    value,
  );
  const durableFiles = await durableFileSnapshot(fixture);
  assert.equal(durableFiles.some((file) => file.includes(JSON.stringify(value))), true);
  const durable = await authoritySnapshot(runtime);
  assert.equal(JSON.stringify(durable.application).includes(JSON.stringify(value)), true);
  const counters = assertExactPreparedEffects(initial, durable, prepared.journal);
  assert.deepEqual(counters, {
    plan: 1,
    journalPreparation: 3 + 2 * prepared.journal.steps.length,
    forwardData: prepared.journal.steps.length,
    activationIntent: 0,
    activationCas: 0,
    activationCompletion: 0,
    failureJournal: 0,
  });
  state.armed = true;
  const failure = await captureFinalFailure(
    runtime,
    prepared,
    "Effective configuration violates its declared schema",
  );
  assert.equal(prepared.journal.activation.status, "pending");
  assert.notEqual(runtime.state, "ready");
  await assertSanitizedSurfaces(runtime, failure, [uri, "private backend unavailable"]);
  effects.assertNone();
  effects.close();
  await assertFreshRetries(reopen, prepared.journal.runId);
  assert.deepEqual(await durableFileSnapshot(fixture), durableFiles);
}

async function assertFreshRetries(reopen, runId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await reopen();
    try {
      await captureExpectedFailure(
        fresh.recoverUpgrade({ version: 1, runId }),
        "FORBIDDEN",
        "Upgrade ownership could not be established",
      );
      assert.notEqual(fresh.state, "ready");
    } finally {
      await fresh.close();
    }
  }
}

async function captureFinalFailure(runtime, prepared, message) {
  try {
    await runDurableFinalValidation(runtime, prepared);
    assert.fail("final validation unexpectedly succeeded");
  } catch (error) {
    exactFinalValidationFailure(error, message);
    return error;
  }
}

function durableValue(mode, uri) {
  if (mode === "unresolved-mount")
    return { _weaver: "mount", source: "svc.missing" };
  if (mode === "mount-cycle")
    return { _weaver: "mount", source: "svc.marker" };
  return { _weaver: "secret-ref", provider: "vault", uri };
}

function resolveSecret(state, mode, expected, actual) {
  if (actual !== expected || !state.armed) return `resolved:${actual}`;
  if (mode === "invalid") return 41;
  if (mode === "missing-backend")
    throw createWeaverError("CONFIG_NOT_READY", "private backend unavailable");
  return undefined;
}

function exactFinalValidationFailure(error, message) {
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.equal(error.message, message);
  return true;
}
