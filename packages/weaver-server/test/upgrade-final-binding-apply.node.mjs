import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSanitizedSurfaces,
  authoritySnapshot,
  captureExpectedFailure,
  corruptActivationIntent,
  durableFileSnapshot,
  observeNoAdmission,
  onlyJournal,
  withFinalMatrixRuntime,
} from "./upgrade-final-matrix-fixture.mjs";
import {
  assertExactDurableDeltas,
  assertExactFailureCommits,
  assertNoRecoveryCommits,
} from "./upgrade-final-effect-proof.mjs";

const mutations = [
  ["runId", (value) => value.runId = "22222222-2222-4222-8222-222222222222"],
  ["nonce", (value) => value.nonce = "0".repeat(64)],
  ["aggregate", (value) => value.aggregateDigest = "0".repeat(64)],
  ["layer", (value) => value.layers[0].contentDigest = "0".repeat(64)],
  ["context id", (value) => value.contexts[0].id = "0".repeat(64)],
  ["context path", (value) => value.contexts[0].scopePath = [{ scopeId: "region", value: "forged" }]],
  ["context order", (value) => value.contexts.reverse()],
  ["authority vector", (value) => value.contexts[0].authorityVector.reverse()],
  ["delivered digest", (value) => value.contexts[0].deliveredDigest = "0".repeat(64)],
];

for (const [name, mutate] of mutations)
  test(`real apply rejects durable finalContexts ${name} mismatch`, async (t) => {
    await withFinalMatrixRuntime(t, async (context) => {
      const { fixture, runtime, request, providerEffects, effectCheckpoint } = context;
      const initial = await authoritySnapshot(runtime);
      const rawInitial = await durableFileSnapshot(fixture);
      const effects = observeNoAdmission(t, runtime);
      const assertCorrupted = corruptActivationIntent(t, runtime, mutate);
      const failure = await captureExpectedFailure(
        runtime.applyUpgrade({ version: 1, request }),
        "REVISION_CONFLICT",
        "Upgrade plan is no longer current",
      );
      assertCorrupted();
      const rejected = await authoritySnapshot(runtime);
      const journal = onlyJournal(rejected.control);
      assertExactDurableDeltas(initial, rejected, journal, 2);
      assertExactFailureCommits(providerEffects.delta(effectCheckpoint), journal, 1, 1);
      assert.notDeepEqual(await durableFileSnapshot(fixture), rawInitial);
      assert.notEqual(runtime.state, "ready");
      effects.assertNone();
      await assertSanitizedSurfaces(runtime, failure);
      effects.close();
      await assertFreshRecovery(context);
    });
  });

async function assertFreshRecovery(context) {
  const { fixture, reopen, providerEffects } = context;
  const raw = await durableFileSnapshot(fixture);
  const checkpoint = providerEffects.checkpoint();
  for (let attempt = 0; attempt < 3; attempt++) {
    await captureStartupFailure(reopen);
    assert.deepEqual(await durableFileSnapshot(fixture), raw);
  }
  assertNoRecoveryCommits(providerEffects.delta(checkpoint));
  providerEffects.assertNoSubscriptions();
  providerEffects.assertDisposed();
}

async function captureStartupFailure(reopen) {
  try {
    await reopen();
    assert.fail("fresh runtime unexpectedly opened");
  } catch (error) {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(
      error.message,
      /Pinned recovery evidence is malformed, unsupported, or divergent/,
    );
    assert.equal(error.message.includes("finalContexts"), false);
  }
}
