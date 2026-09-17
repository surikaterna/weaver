import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeRunInstance,
  createAppliedRun,
  durableSequences,
  newCounters,
  persistJournalCorruption,
  reopenRun,
} from "./upgrade-compensation-fixture.mjs";
import {
  assertStaleRow,
  forgedId,
  selected,
  zeroDigest,
} from "./upgrade-stale-matrix-fixture.mjs";

const rows = [
  ["journal source/target catalog reference", (envelope, runId) => {
    const { journal } = selected(envelope, runId);
    journal.source.digest = zeroDigest();
    journal.target.digest = zeroDigest();
  }],
  ["journal sourceRevisions/cursor provider identity", (envelope, runId) => {
    const { journal } = selected(envelope, runId);
    journal.sourceRevisions[1].providerId = forgedId();
    journal.cursor[1].providerId = forgedId();
  }],
  ["journal control provider/store/environment/layer", (envelope, runId) => {
    const control = selected(envelope, runId).journal.control;
    control.providerId = forgedId();
    control.revision.storeId = forgedId();
    control.revision.environment = "forged";
    control.revision.layer = forgedId();
  }],
  ["journal control operation and receipt lineage", (envelope, runId) => {
    const control = selected(envelope, runId).journal.control;
    control.operationId = "00000000-0000-4000-8000-000000000001";
    control.receipts.at(-1).mutationDigest = zeroDigest();
  }],
  ["journal step mutation and prior/result receipt", (envelope, runId) => {
    const step = selected(envelope, runId).journal.steps[0];
    step.mutation.value = { keep: false, added: "forged" };
    step.receipt.mutationDigest = zeroDigest();
  }],
];

for (const [name, mutate] of rows)
  test(`stale journal: ${name}`, (t) =>
    assertStaleRow(t, { name, schemaInvalid: false, mutate }));

test("blocked/conflict repeat returns the stable state without rewriting", async (t) => {
  const counters = newCounters();
  const run = await createAppliedRun(t, counters);
  try {
    await persistJournalCorruption(run.runtime, run.runId, (journal) => {
      journal.phase = "blocked";
      journal.failure = { code: "conflict", message: "stable conflict" };
    });
    await closeRunInstance(run, counters);
    await reopenRun(run, t, counters);
    const before = await durableSequences(run.runtime);
    const request = {
      version: 1,
      runId: run.runId,
      priorOwnerStopped: {
        observedAt: new Date().toISOString(),
        evidence: "prior filesystem-backed runtime closed",
      },
    };
    const first = await run.runtime.recoverUpgrade(request);
    assert.equal(first.status, "blocked");
    assert.deepEqual(await durableSequences(run.runtime), before);
    await closeRunInstance(run, counters);
    await reopenRun(run, t, counters);
    const second = await run.runtime.recoverUpgrade(request);
    assert.deepEqual(second, first);
    assert.deepEqual(await durableSequences(run.runtime), before);
  } finally {
    await closeRunInstance(run, counters);
    await run.fixture.dispose();
  }
});
