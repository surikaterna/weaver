import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  assertSanitizedSurfaces,
  authoritySnapshot,
  captureExpectedFailure,
  corruptIntentJournal,
  durableFileSnapshot,
  observeNoAdmission,
  onlyJournal,
  withFinalMatrixRuntime,
} from "./upgrade-final-matrix-fixture.mjs";
import {
  assertExactDurableDeltas,
  assertExactFailureCommits,
  assertNoRecoveryCommits,
  upgradePrivateFragments,
} from "./upgrade-final-effect-proof.mjs";

const mutations = [
  ["wrong final-layer binding", (journal) => {
    journal.activation.finalContexts.layers[0].revision.layer = "wrong-layer";
  }],
  ["receipt operation", (journal) => {
    journal.steps[0].receipt.operationId = randomUUID();
  }],
  ["receipt mutation", (journal) => {
    journal.steps[0].receipt.mutationDigest = "0".repeat(64);
  }],
  ["receipt previous revision", (journal) => {
    journal.steps[0].receipt.previousRevision.sequence = "0";
  }],
  ["receipt new revision", (journal) => {
    journal.steps[0].receipt.revision.sequence = "999";
  }],
  ["receipt cursor", (journal) => {
    journal.cursor[0].revision.sequence = "999";
  }],
];

for (const [name, mutate] of mutations)
  test(`real apply rejects durable ${name} mismatch`, async (t) => {
    await withFinalMatrixRuntime(t, async (context) => {
      const { fixture, runtime, request, providerEffects, effectCheckpoint } = context;
      const initial = await authoritySnapshot(runtime);
      const rawInitial = await durableFileSnapshot(fixture);
      const effects = observeNoAdmission(t, runtime);
      const assertCorrupted = corruptIntentJournal(t, runtime, mutate);
      const failure = await captureExpectedFailure(
        runtime.applyUpgrade({ version: 1, request }),
        "COMMIT_OUTCOME_UNKNOWN",
        "Upgrade outcome is uncertain; operator action is required",
      );
      assertCorrupted();
      const rejected = await authoritySnapshot(runtime);
      const journal = onlyJournal(rejected.control);
      assertExactDurableDeltas(
        initial, rejected, journal, 2, !name.startsWith("receipt "),
      );
      assertExactFailureCommits(providerEffects.delta(effectCheckpoint), journal, 1, 1);
      assert.notDeepEqual(await durableFileSnapshot(fixture), rawInitial);
      assert.notEqual(runtime.state, "ready");
      effects.assertNone();
      await assertSanitizedSurfaces(runtime, failure,
        upgradePrivateFragments(fixture, journal, [
          "wrong-layer", "999", "0".repeat(64),
        ]));
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
    assert.equal(
      error.message,
      "WeaverError: Pinned recovery evidence is malformed, unsupported, or divergent",
    );
  }
}
