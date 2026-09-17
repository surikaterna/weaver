import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLifecycle,
  assertNoLifecycleLeaks,
  assertNoPublication,
  closeRunInstance,
  compensate,
  createAppliedRun,
  durableSequences,
  installCrash,
  newCounters,
  persistCompensationIntent,
  persistDataCorruption,
  persistJournalCorruption,
  provider,
  rawJournal,
  recoveryJournal,
  reopenRun,
} from "./upgrade-compensation-fixture.mjs";

for (const boundary of [
  "before-intent",
  "after-intent",
  "after-data",
  "after-complete",
]) {
  test(`filesystem restart reconciles compensation ${boundary}`, async (t) => {
    const counters = newCounters();
    const run = await createAppliedRun(t, counters);
    const baseline = await durableSequences(run.runtime);
    const beforeCrash = run.observation.snapshot();
    const restoreCrash = installCrash(t, run.runtime, boundary, counters);
    try {
      await assert.rejects(compensate(run.runtime, run.runId));
      assertNoPublication(run.observation, beforeCrash, boundary !== "before-intent");
      restoreCrash();
      await closeRunInstance(run, counters);
      await reopenRun(run, t, counters);
      await recoverAndAssert(run, counters, true);
      await closeRunInstance(run, counters);
      await reopenRun(run, t, counters);
      await recoverAndAssert(run, counters, false);
      await assertFinalState(run, counters, baseline, boundary);
    } finally {
      restoreCrash();
      await closeRunInstance(run, counters);
      await run.fixture.dispose();
    }
    assertLifecycle(run, counters);
  });
}

test("restart skips a completed reverse suffix and continues in reverse order", async (t) => {
  const counters = newCounters();
  const run = await createAppliedRun(t, counters, true);
  const expected = recoveryJournal(run.runtime, run.runId).steps
    .map((step) => step.target.path.slice(1).replaceAll("/", "."))
    .reverse();
  const restoreCrash = installCrash(t, run.runtime, "after-complete", counters);
  try {
    await assert.rejects(compensate(run.runtime, run.runId));
    assert.deepEqual(counters.reverseOrder, expected.slice(0, 1));
    restoreCrash();
    await closeRunInstance(run, counters);
    await reopenRun(run, t, counters);
    await recoverAndAssert(run, counters, true);
    assert.deepEqual(counters.reverseOrder, expected);
    assert.equal(new Set(counters.reverseOrder).size, 2);
    await closeRunInstance(run, counters);
    await reopenRun(run, t, counters);
    await recoverAndAssert(run, counters, false);
    const journal = recoveryJournal(run.runtime, run.runId);
    const cursor = journal.cursor.find((item) => item.providerId === "platform");
    assert.deepEqual(cursor.revision, journal.steps[0].compensation.receipt.revision);
  } finally {
    restoreCrash();
    await closeRunInstance(run, counters);
    await run.fixture.dispose();
  }
  assertLifecycle(run, counters);
});

for (const mismatch of [
  "operation-id",
  "revision",
  "digest",
  "state",
  "receipt",
  "cursor",
]) {
  test(`restarted compensation blocks durable ${mismatch} mismatch`, async (t) => {
    const counters = newCounters();
    const run = await createAppliedRun(t, counters);
    try {
      await persistCompensationIntent(run.runtime, run.runId, counters);
      await persistMismatch(run.runtime, run.runId, mismatch);
      const persisted = await durableState(run.runtime, run.runId);
      await closeRunInstance(run, counters);
      await reopenRun(run, t, counters);
      assertPersisted(await durableState(run.runtime, run.runId), persisted);
      const before = await durableState(run.runtime, run.runId);
      const observation = run.observation.snapshot();
      const outcome = await compensate(run.runtime, run.runId);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.failure.code, "operator-required");
      const blocked = await durableState(run.runtime, run.runId);
      assertBlockedTransition(before, blocked, run.runId);
      assert.equal(counters.reverseEffects, 0);
      assert.equal(counters.intents.size, 1);
      assert.equal(counters.completions.size, 0);
      assert.equal(counters.otherJournal.size, 2);
      assertNoPublication(run.observation, observation, true);
      await closeRunInstance(run, counters);
      await reopenRun(run, t, counters);
      assert.deepEqual(await rawJournal(run.runtime, run.runId), blocked.journal);
      const retryData = await durableState(run.runtime, run.runId);
      const retry = await compensate(run.runtime, run.runId);
      assert.equal(retry.status, "blocked");
      assertBlockedTransition(
        retryData,
        await durableState(run.runtime, run.runId),
        run.runId,
        2n,
      );
      assert.equal(counters.reverseEffects, 0);
      assert.equal(counters.otherJournal.size, 4);
    } finally {
      await closeRunInstance(run, counters);
      await run.fixture.dispose();
    }
    assertLifecycle(run, counters);
  });
}

for (const identity of ["provider", "layer", "store", "environment"]) {
  test(`durable ${identity} identity corruption fails closed on every open`, async (t) => {
    const counters = newCounters();
    const run = await createAppliedRun(t, counters);
    try {
      await persistCompensationIntent(run.runtime, run.runId, counters);
      await persistJournalCorruption(run.runtime, run.runId, (journal) =>
        corruptIdentity(journal, identity),
      );
      const persisted = await durableState(run.runtime, run.runId);
      await closeRunInstance(run, counters);
      // U6 owns maintenance-open routing; U3 proves current startup admission is repeatably fail-closed.
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(reopenRun(run, t, counters), {
          code: "VALIDATION_ERROR",
        });
        assertPersisted(await durableFixtureState(run.fixture, run.runId), persisted);
      }
      assert.equal(counters.reverseEffects, 0);
      assert.equal(counters.intents.size, 1);
      assert.equal(counters.completions.size, 0);
    } finally {
      await closeRunInstance(run, counters);
      await run.fixture.dispose();
    }
    assert.equal(counters.openAttempts, 3);
    assertNoLifecycleLeaks(run, counters);
  });
}

async function recoverAndAssert(run, counters, allowRevision) {
  const before = run.observation.snapshot();
  const outcome = await compensate(run.runtime, run.runId);
  assert.equal(outcome.status, "compensated");
  assert.equal("journal" in outcome, false);
  assertNoPublication(run.observation, before, allowRevision);
}

async function assertFinalState(run, counters, baseline, boundary) {
  const final = await durableSequences(run.runtime);
  assert.equal(counters.reverseEffects, 1);
  assert.equal(counters.intents.size, 1);
  assert.equal(counters.completions.size, 1);
  assert.equal(counters.otherJournal.size, boundary === "after-complete" ? 0 : 1);
  assert.equal(final.platform - baseline.platform, 1n);
  assert.equal(final.control - baseline.control, boundary === "after-complete" ? 2n : 3n);
  assert.deepEqual(
    (await provider(run.runtime, "platform").authority.readLayer("platform")).entries,
    { svc: { keep: true } },
  );
}

async function persistMismatch(runtime, runId, mismatch) {
  const journal = await rawJournal(runtime, runId);
  return persistDataCorruption(runtime, mismatch, journal);
}

function corruptIdentity(journal, identity) {
  const step = journal.steps[0];
  if (identity === "provider") step.target.providerId = "conflicting-provider";
  if (identity === "layer") step.target.layer = "conflicting-layer";
  if (identity === "store") step.target.storeId = "fs:/conflicting-store";
  if (identity === "environment")
    journal.cursor.find((item) => item.providerId === "platform").revision.environment =
      "conflicting";
}

async function durableState(runtime, runId) {
  return {
    journal: structuredClone(await rawJournal(runtime, runId)),
    platform: structuredClone(
      await provider(runtime, "platform").authority.readLayer("platform"),
    ),
    control: structuredClone(
      await provider(runtime, "control").authority.readLayer("control"),
    ),
  };
}

async function durableFixtureState(fixture, runId) {
  const runtime = await import("@weaver-conf/storage-providers");
  const create = runtime.createFileSystemStorageProvider;
  const controlPath = fixture.seed.store.locator.filePath;
  const platformPath = fixture.request.generation.providers.find(
    (item) => item.id === "platform",
  ).options.filePath;
  const control = createFileReader("control", controlPath, create);
  const platform = createFileReader("platform", platformPath, create);
  const controlEnvelope = await control.authority.readLayer("control");
  return {
    journal: structuredClone(controlEnvelope.entries._weaver.upgrades.journal[runId]),
    platform: structuredClone(await platform.authority.readLayer("platform")),
    control: structuredClone(controlEnvelope),
  };
}

function createFileReader(layer, filePath, create) {
  return create({
    id: layer,
    layer,
    filePath,
    authority: { environment: "dev", initialize: false, layers: [layer] },
  });
}

function assertPersisted(actual, expected) {
  assert.deepEqual(actual.journal, expected.journal);
  assert.deepEqual(actual.platform, expected.platform);
}

function assertBlockedTransition(before, after, runId, revisionDelta = 2n) {
  assert.deepEqual(after.platform, before.platform);
  assert.equal(
    BigInt(after.control.sequence) - BigInt(before.control.sequence),
    revisionDelta,
  );
  const beforeEntries = structuredClone(before.control.entries);
  const afterEntries = structuredClone(after.control.entries);
  delete beforeEntries._weaver.upgrades.journal[runId];
  delete afterEntries._weaver.upgrades.journal[runId];
  assert.deepEqual(afterEntries, beforeEntries);
  const expected = structuredClone(before.journal);
  delete expected.owner;
  delete expected.adoption;
  delete expected.phase;
  delete expected.failure;
  delete expected.control;
  expected.cursor = expected.cursor.filter((entry) => entry.providerId !== "control");
  const actual = structuredClone(after.journal);
  delete actual.owner;
  delete actual.adoption;
  delete actual.phase;
  delete actual.failure;
  delete actual.control;
  actual.cursor = actual.cursor.filter((entry) => entry.providerId !== "control");
  assert.deepEqual(actual, expected);
  assert.equal(after.journal.phase, "blocked");
  assert.equal(after.journal.failure.code, "operator-required");
}
