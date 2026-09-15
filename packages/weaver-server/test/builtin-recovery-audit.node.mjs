import assert from "node:assert/strict";
import { test } from "node:test";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { prepareBuiltinCatalog, readBuiltinRecoveryEnvelope } from "../src/core/builtin-catalog.ts";
import { binding, catalogState, completedJournal, dataReceipt, identifyPlan, revision, trustedAuthorities, upgradeLayerBinding, upgradePlan } from "./builtin-catalog-fixtures.mjs";

test("F1 the real provider request digest binds recorded mutation, path and expected revision", () => {
  const journal = completedJournal();
  assert.equal(readBuiltinRecoveryEnvelope(journal).phase, "completed");
  for (const mutate of [
    (j) => { j.steps[0].mutation.value = 999; },
    (j) => { j.steps[0].target.path = "/svc/other"; },
    (j) => { j.steps[0].receipt.mutationDigest = "0".repeat(64); },
    (j) => { j.steps[0].receipt.previousRevision.sequence = "0"; j.steps[0].receipt.revision.sequence = "1"; },
    (j) => { j.steps[0].receipt.mutationDigest = computeProviderMutationDigest({ layer: revision.layer, expectedRevision: revision, operationId: j.steps[0].operationId, mutation: { action: "set", key: "svc/port", value: 80 } }); },
  ]) {
    const bad = structuredClone(journal); mutate(bad);
    assert.throws(() => readBuiltinRecoveryEnvelope(bad), (error) => error.code === "VALIDATION_ERROR");
  }
});

test("F1 unrelated, stale, duplicate or unjustifiably advanced completion cursors refuse", () => {
  for (const mutate of [
    (j) => { j.cursor[0].revision = { ...revision, environment: "prod", storeId: "other", sequence: "0" }; },
    (j) => { j.cursor[0].revision.sequence = "0"; },
    (j) => { j.cursor[0].revision.sequence = "5"; },
    (j) => { j.cursor[0].providerId = "other"; },
    (j) => { j.cursor.push(structuredClone(j.cursor[0])); },
  ]) {
    const journal = completedJournal(); mutate(journal);
    assert.throws(() => readBuiltinRecoveryEnvelope(journal), /cursor/);
  }
});

function bookkeepingReceipt(previous, operationId) {
  const request = { layer: previous.layer, expectedRevision: previous, operationId, mutation: { action: "set", key: "_weaver.upgrades.journal", value: {} } };
  return { operationId, previousRevision: previous, revision: { ...previous, sequence: String(BigInt(previous.sequence) + 1n) }, mutationDigest: computeProviderMutationDigest(request) };
}

function rollingJournal() {
  const journal = completedJournal(); const step = journal.steps[0];
  const intent = bookkeepingReceipt(revision, step.intentOperationId);
  step.receipt = dataReceipt(step, intent.revision);
  const completion = bookkeepingReceipt(step.receipt.revision, "66666666-6666-4666-8666-666666666666");
  journal.control = { providerId: "disk", revision: structuredClone(revision), receipts: [intent, completion], operationId: "77777777-7777-4777-8777-777777777777" };
  journal.sourceRevisions = [{ providerId: "disk", revision: structuredClone(revision) }];
  journal.cursor = [{ providerId: "disk", revision: structuredClone(completion.revision) }];
  return journal;
}

test("F1 valid control-provider intent/data/completion lineage permits rolling cursors", () => {
  const journal = rollingJournal();
  assert.equal(journal.steps[0].preRevision.sequence, "1");
  assert.equal(journal.steps[0].receipt.previousRevision.sequence, "2");
  assert.equal(journal.cursor[0].revision.sequence, "4");
  assert.equal(readBuiltinRecoveryEnvelope(journal).phase, "completed");
  for (const mutate of [
    (j) => { j.control.receipts.shift(); },
    (j) => { j.control.receipts.pop(); },
    (j) => { j.steps[0].receipt = dataReceipt(j.steps[0]); },
    (j) => { j.control.receipts[1].previousRevision.sequence = "7"; },
    (j) => { j.cursor[0].revision.environment = "prod"; },
  ]) {
    const bad = structuredClone(journal); mutate(bad);
    assert.throws(() => readBuiltinRecoveryEnvelope(bad));
  }
});

test("F1 applying control checkpoints and untouched source authorities remain readable", () => {
  const applying = rollingJournal();
  applying.phase = "applying";
  applying.steps[0].status = "intent";
  delete applying.steps[0].receipt;
  applying.control.receipts = applying.control.receipts.slice(0, 1);
  applying.cursor[0].revision = structuredClone(applying.control.receipts[0].revision);
  assert.equal(readBuiltinRecoveryEnvelope(applying).phase, "applying");
  const completed = completedJournal();
  const dependency = { providerId: "read", revision: { ...revision, storeId: "fs:read", layer: "defaults", sequence: "10" } };
  completed.sourceRevisions = [dependency];
  completed.cursor.push(structuredClone(dependency));
  assert.equal(readBuiltinRecoveryEnvelope(completed).phase, "completed");
  completed.cursor.pop();
  assert.throws(() => readBuiltinRecoveryEnvelope(completed), /omits/);
});

test("F1/F2 prepared catalog binds journal content to its plan while standalone recovery ignores target catalog", () => {
  const state = catalogState(); const journal = rollingJournal(); const step = journal.steps[0];
  state.format.storeId = revision.storeId;
  const plan = upgradePlan(); const layer = upgradeLayerBinding("disk", revision, { svc: { port: 0 } }, { svc: { port: 80 } });
  plan.source.dataDigests = [layer.source]; plan.finalLayers = [layer.final];
  plan.steps = [{ id: step.id, target: step.target, expectedRevision: step.preRevision, preDigest: step.preDigest, postDigest: step.postDigest, mutation: step.mutation, reversible: false }];
  const identified = identifyPlan(plan); journal.planId = identified.id;
  state.upgrades.plans[identified.id] = identified; state.upgrades.journal[journal.runId] = journal;
  assert.equal(prepareBuiltinCatalog(state, { ...binding, storeId: revision.storeId }, trustedAuthorities()).configuration.upgrades.journal[journal.runId].phase, "completed");
  const bad = structuredClone(state); bad.upgrades.journal[journal.runId].steps[0].postDigest = "e".repeat(64);
  assert.throws(() => prepareBuiltinCatalog(bad, { ...binding, storeId: revision.storeId }, trustedAuthorities()), /step content/);
  assert.equal(readBuiltinRecoveryEnvelope(journal).target.version, 99);
});
