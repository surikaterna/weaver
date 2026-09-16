import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rmdir } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import test from "node:test";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  internalUpgradeLayerDigest,
  layerCommitRequestSchema,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { activationCompletionOperationId } from "../src/core/activation-completion-operation.ts";
import {
  activeSubprocessDeadlines,
  startWorker,
  SUBPROCESS_STDERR_CAP_BYTES,
} from "./subprocess-harness.mjs";
import {
  createTwoProviderFixture,
  installTwoProviderPlan,
  journalFrom,
  rawState,
} from "./upgrade-two-provider-fixture.mjs";

test("U9.2 real process death preserves filesystem truth and recovery exclusion", { timeout: 175_000 }, async (t) => {
  const fixture = await createTwoProviderFixture();
  const workers = [];
  const paths = providerPaths(fixture);
  try {
    const prepared = await prepareFixture(fixture, paths);
    const crashed = await crashAndProbe(t, fixture, paths, workers, prepared);
    await removeKnownLocks(paths, fixture.directory);
    const recovered = await recoverWithContention(paths, workers, prepared.start, crashed.apply);
    const finalBytes = await snapshots(paths);
    const final = parseSnapshots(finalBytes);
    assertWinner(crashed.partial, crashed.partialBytes, final, finalBytes,
      crashed.journal, prepared.installed.plan, recovered);
    await assertLocks(paths, fixture.directory, false);
    await assertTerminalRecovery(paths, workers, prepared.start);
    await assertLocks(paths, fixture.directory, false);
    assertNoHarnessLeaks(workers);
  } finally {
    await stopWorkers(workers);
    await removeKnownLocks(paths, fixture.directory);
    await fixture.dispose();
  }
});

test("U9.2 subprocess diagnostics retain only a bounded stderr tail", async () => {
  const worker = startWorker({ type: "start", mode: "stderr-stall" });
  try {
    assert.deepEqual(await worker.nextAny(), { type: "worker-online" });
    assert.deepEqual(await worker.nextAny(), { type: "stderr-ready" });
    const error = await rejection(worker.next("never-emitted", 250));
    assert.match(error.message,
      /\[stderr truncated: retained 16384\/\d+ bytes; cap 16384\]/);
    assert.equal(error.message.includes("retained-stderr-tail-sentinel"), true);
    assert.equal(error.message.includes("discarded-stderr-sentinel"), false);
    assert.ok(Buffer.byteLength(error.message) <= SUBPROCESS_STDERR_CAP_BYTES + 256);
    assert.equal(worker.pending, 0);
  } finally {
    if (!worker.exited) worker.child.kill("SIGTERM");
    await worker.wait();
  }
  assert.equal(worker.exited, true);
  assert.equal(worker.pending, 0);
  assert.equal(activeSubprocessDeadlines(), 0);
  assert.equal(worker.child.stdout.listenerCount("data"), 0);
  assert.equal(worker.child.stderr.listenerCount("data"), 0);
});

async function rejection(operation) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("Expected rejection");
}

async function prepareFixture(fixture, paths) {
  const runtime = await fixture.open();
  try {
    const installed = await installTwoProviderPlan(runtime, fixture);
    const baseline = await rawState(runtime);
    return { installed, baseline, baselineBytes: await snapshots(paths), start: {
      type: "start",
      seed: fixture.seed,
      request: installed.request,
      runId: randomUUID(),
      planId: installed.plan.id,
    } };
  } finally {
    await runtime.close();
  }
}

async function crashAndProbe(t, fixture, paths, workers, prepared) {
  const startedAt = performance.now();
  const apply = track(workers, startWorker({ ...prepared.start, mode: "apply" }));
  const progress = await consumeApplyProgress(apply, prepared, startedAt);
  t.diagnostic(`apply milestones: ${progress.timings.join(", ")}`);
  assert.equal(apply.child.kill("SIGKILL"), true);
  assert.deepEqual(await apply.wait(), { code: null, signal: "SIGKILL" });
  const partialBytes = await snapshots(paths);
  const partial = parseSnapshots(partialBytes);
  const journal = journalFrom(partial, prepared.start.runId);
  assertPartial(prepared.baseline, prepared.baselineBytes, partial, partialBytes,
    journal, prepared.installed.plan);
  await assertLocks(paths, fixture.directory, true);
  const beforeProbe = await snapshots(paths);
  const probe = track(workers, startWorker({ ...prepared.start, mode: "recover" }));
  assert.deepEqual(await probe.next("error"), { type: "error", code: "WRITER_CONFLICT" });
  assert.deepEqual(await probe.wait(), { code: 1, signal: null });
  assertSnapshotsEqual(await snapshots(paths), beforeProbe);
  await assertLocks(paths, fixture.directory, true);
  return { apply, partialBytes, partial, journal };
}

async function consumeApplyProgress(worker, prepared, startedAt) {
  const expected = ["worker-online", "runtime-module-ready", "authority-module-ready",
    "fixture-module-ready", "runtime-opened", "apply-invoked",
    "platform-commit-durable", "step0-complete", "step1-intent", "partial-ready"];
  const messages = new Map();
  const timings = [];
  let previousAt = startedAt;
  for (const type of expected) {
    const message = await worker.nextAny(10_000);
    const observedAt = performance.now();
    assert.equal(message.type, type);
    assert.equal(message.runId, prepared.start.runId);
    assert.equal(message.planId, prepared.installed.plan.id);
    assert.ok(observedAt - previousAt < 10_000);
    timings.push(`${type}=${Math.round(observedAt - startedAt)}ms(+${Math.round(observedAt - previousAt)})`);
    messages.set(type, message);
    previousAt = observedAt;
  }
  assertApplyProgressIdentity(messages, prepared.installed.plan);
  assert.equal(worker.queued, 0);
  return { timings };
}

function assertApplyProgressIdentity(messages, plan) {
  const durable = messages.get("platform-commit-durable");
  const step0 = messages.get("step0-complete");
  const step1 = messages.get("step1-intent");
  const partial = messages.get("partial-ready");
  assert.equal(step0.stepId, plan.steps[0].id);
  assert.equal(step1.stepId, plan.steps[1].id);
  assert.equal(durable.operationId, step0.operationId);
  assert.equal(durable.receiptOperationId, step0.operationId);
  assert.equal(step0.receiptOperationId, step0.operationId);
  assert.equal(partial.platformOperationId, step0.operationId);
  assert.equal(partial.secondaryOperationId, step1.operationId);
}

async function recoverWithContention(paths, workers, start, apply) {
  const winner = track(workers, startWorker({ ...start, mode: "recover" }));
  await winner.next("locks-acquired");
  const beforeLoser = await snapshots(paths);
  const loser = track(workers, startWorker({ ...start, mode: "recover" }));
  assert.deepEqual(await loser.next("error"), { type: "error", code: "WRITER_CONFLICT" });
  assert.deepEqual(await loser.wait(), { code: 1, signal: null });
  assertSnapshotsEqual(await snapshots(paths), beforeLoser);
  winner.send({ type: "recover", priorOwnerStopped: {
    observedAt: new Date().toISOString(),
    evidence: `parent reaped exact apply child ${apply.child.pid}`,
  } });
  const recovered = await winner.next("recovered");
  assert.equal(recovered.result.status, "completed");
  assert.deepEqual(pickDataCounts(recovered.counts), { platform: 0, secondary: 1 });
  winner.send({ type: "close" });
  await winner.next("closed");
  assert.deepEqual(await winner.wait(), { code: 0, signal: null });
  return recovered;
}

async function assertTerminalRecovery(paths, workers, start) {
  const terminal = track(workers, startWorker({ ...start, mode: "recover" }));
  await terminal.next("locks-acquired");
  const before = await snapshots(paths);
  terminal.send({ type: "recover" });
  const first = await terminal.next("recovered");
  terminal.send({ type: "recover" });
  const second = await terminal.next("recovered");
  for (const result of [first, second]) {
    assert.equal(result.result.status, "completed");
    assert.deepEqual(result.counts, { control: 0, platform: 0, secondary: 0 });
    assert.deepEqual(result.receipts, []);
  }
  terminal.send({ type: "close" });
  await terminal.next("closed");
  assert.deepEqual(await terminal.wait(), { code: 0, signal: null });
  assertSnapshotsEqual(await snapshots(paths), before);
}

function providerPaths(fixture) {
  return Object.fromEntries(["control", "platform", "secondary"].map((id) => {
    const filePath = id === "control"
      ? fixture.seed.store.locator.filePath
      : fixture.request.generation.providers.find((provider) => provider.id === id)?.options.filePath;
    assert.equal(typeof filePath, "string");
    return [id, filePath];
  }));
}

async function snapshots(paths) {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([id, path]) =>
    [id, await readFile(path, "utf8")])));
}

function parseSnapshots(bytes) {
  return Object.fromEntries(Object.entries(bytes).map(([id, value]) => [id, JSON.parse(value)]));
}

function assertSnapshotsEqual(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.deepEqual(parseSnapshots(actual), parseSnapshots(expected));
}

function assertPartial(before, beforeBytes, partial, partialBytes, journal, plan) {
  assert.equal(journal.phase, "applying");
  assert.equal(journal.planId, plan.id);
  assert.equal(journal.activation.status, "pending");
  assert.equal(journal.steps[0].status, "complete");
  assertStep(journal.steps[0], plan.steps[0]);
  assert.equal(journal.steps[0].receipt.operationId, journal.steps[0].operationId);
  assert.equal(journal.steps[0].receipt.mutationDigest, receiptDigest(journal.steps[0]));
  assert.deepEqual(journal.steps[0].receipt.previousRevision, revision(before.platform));
  assert.deepEqual(journal.steps[0].receipt.revision, revision(partial.platform));
  assert.deepEqual(partial.platform.lastCommit, journal.steps[0].receipt);
  assert.equal(BigInt(partial.platform.sequence) - BigInt(before.platform.sequence), 1n);
  assert.equal(journal.steps[1].status, "intent");
  assert.equal("receipt" in journal.steps[1], false);
  assertStep(journal.steps[1], plan.steps[1]);
  assert.deepEqual(journal.steps[1].preRevision, revision(before.secondary));
  assert.equal(partialBytes.secondary, beforeBytes.secondary);
  assert.deepEqual(partial.secondary, before.secondary);
}

function assertStep(recorded, planned) {
  for (const key of ["id", "target", "preDigest", "postDigest", "mutation"])
    assert.deepEqual(recorded[key], planned[key]);
  assert.equal(recorded.preRevision.storeId, planned.expectedRevision.storeId);
  assert.equal(recorded.preRevision.layer, planned.expectedRevision.layer);
}

function assertWinner(partial, partialBytes, final, finalBytes, oldJournal, plan, recovered) {
  assert.equal(finalBytes.platform, partialBytes.platform);
  assert.deepEqual(final.platform, partial.platform);
  assert.equal(BigInt(final.secondary.sequence) - BigInt(partial.secondary.sequence), 1n);
  const journal = journalFrom(final, oldJournal.runId);
  assert.equal(journal.phase, "completed");
  assert.equal(journal.steps[0].operationId, oldJournal.steps[0].operationId);
  assert.deepEqual(journal.steps[0].receipt, oldJournal.steps[0].receipt);
  assert.equal(journal.steps[1].status, "complete");
  assert.equal(journal.steps[1].operationId, oldJournal.steps[1].operationId);
  assert.deepEqual(journal.steps[1].mutation, oldJournal.steps[1].mutation);
  assert.deepEqual(journal.steps[1].receipt.previousRevision, revision(partial.secondary));
  assert.deepEqual(journal.steps[1].receipt.revision, revision(final.secondary));
  assert.equal(journal.steps[1].receipt.mutationDigest, receiptDigest(journal.steps[1]));
  assert.deepEqual(final.secondary.lastCommit, journal.steps[1].receipt);
  assert.equal(journal.activation.status, "complete");
  assert.equal(journal.activation.receipt.operationId, journal.activation.operationId);
  assert.equal(final.control.lastCommit.operationId, activationCompletionOperationId(oldJournal.runId));
  assert.equal(countReceipts(recovered.receipts, journal.activation.operationId), 1);
  assert.equal(countReceipts(recovered.receipts, activationCompletionOperationId(oldJournal.runId)), 1);
  assertFinalEvidence(final, journal, plan);
}

function assertFinalEvidence(state, journal, plan) {
  assert.equal(journal.activation.finalContexts.planId, plan.id);
  assert.equal(journal.activation.finalContexts.targetCatalogDigest, plan.target.catalogDigest);
  assert.deepEqual(journal.activation.finalContexts.contexts.map((item) => item.scopePath), plan.contexts);
  assert.deepEqual(journal.activation.finalContexts.layers.map((item) => ({
    providerId: item.providerId,
    namespace: item.namespace,
    contentDigest: item.contentDigest,
  })), plan.finalLayers.map((item) => ({
    providerId: item.providerId,
    namespace: item.namespace,
    contentDigest: item.finalDigest,
  })));
  for (const binding of plan.finalLayers) {
    const envelope = state[binding.providerId];
    assert.equal(internalUpgradeLayerDigest(envelope.entries, binding.contentDomain), binding.finalDigest);
    const evidence = journal.activation.finalContexts.layers.find((item) =>
      item.providerId === binding.providerId && item.revision.layer === binding.layer);
    assert.ok(evidence);
    assert.equal(evidence.namespace, binding.namespace);
    assert.equal(evidence.contentDigest, binding.finalDigest);
    if (binding.providerId !== "control") assert.deepEqual(evidence.revision, revision(envelope));
  }
}

function receiptDigest(step) {
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  return computeProviderMutationDigest(layerCommitRequestSchema.parse({
    layer: step.target.layer,
    expectedRevision: step.receipt.previousRevision,
    operationId: step.operationId,
    mutation: step.mutation.action === "set"
      ? { action: "set", key, value: step.mutation.value }
      : { action: "remove", key },
  }));
}

function revision(envelope) {
  const { storeId, environment, layer, epoch, sequence } = envelope;
  return { storeId, environment, layer, epoch, sequence };
}

function countReceipts(receipts, operationId) {
  return receipts.filter((item) => item.receipt?.operationId === operationId).length;
}

function pickDataCounts(counts) {
  return { platform: counts.platform, secondary: counts.secondary };
}

function track(workers, worker) {
  workers.push(worker);
  return worker;
}

async function assertLocks(paths, root, present) {
  for (const path of Object.values(paths)) {
    const lock = safeLockPath(path, root);
    if (!present) {
      await assert.rejects(lstat(lock), { code: "ENOENT" });
      continue;
    }
    const stat = await lstat(lock);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.deepEqual(await readdir(lock), []);
  }
}

async function removeKnownLocks(paths, root) {
  for (const path of Object.values(paths)) {
    const lock = safeLockPath(path, root);
    try {
      const stat = await lstat(lock);
      assert.equal(stat.isDirectory(), true);
      assert.equal(stat.isSymbolicLink(), false);
      assert.deepEqual(await readdir(lock), []);
      await rmdir(lock);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function safeLockPath(filePath, root) {
  const lock = resolve(dirname(filePath), ".weaver-writer");
  const within = relative(resolve(root), lock);
  assert.equal(basename(lock), ".weaver-writer");
  assert.equal(within.startsWith("..") || resolve(root) === lock, false);
  return lock;
}

async function stopWorkers(workers) {
  for (const worker of workers) {
    if (worker.exited) continue;
    worker.child.kill("SIGTERM");
    try { await worker.wait(2_000); }
    catch {
      worker.child.kill("SIGKILL");
      await worker.wait(2_000);
    }
  }
}

function assertNoHarnessLeaks(workers) {
  assert.equal(activeSubprocessDeadlines(), 0);
  for (const worker of workers) {
    assert.equal(worker.exited, true);
    assert.equal(worker.pending, 0);
    assert.equal(worker.child.stdout.listenerCount("data"), 0);
    assert.equal(worker.child.stderr.listenerCount("data"), 0);
  }
}
