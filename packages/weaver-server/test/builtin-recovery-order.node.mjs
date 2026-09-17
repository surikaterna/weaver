import assert from "node:assert/strict";
import { test } from "node:test";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { prepareBuiltinCatalog, readBuiltinRecoveryEnvelope } from "../src/core/builtin-catalog.ts";
import { binding, catalogState, completedJournal, dataReceipt, identifyPlan, revision, trustedAuthorities, upgradeLayerBinding, upgradePlan } from "./builtin-catalog-fixtures.mjs";

const uuid = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function nextStep(first, preRevision = first.receipt.revision) {
  const step = { ...structuredClone(first), id: "s2", operationId: uuid("7"), intentOperationId: uuid("8"), preRevision,
    preDigest: first.postDigest, postDigest: "d".repeat(64), mutation: { action: "set", value: 999 } };
  step.receipt = dataReceipt(step);
  return step;
}

function orderedJournal() {
  const journal = completedJournal();
  journal.sourceRevisions = [{ providerId: "disk", revision: structuredClone(revision) }];
  journal.steps.push(nextStep(journal.steps[0]));
  journal.cursor[0].revision = structuredClone(journal.steps[1].receipt.revision);
  return journal;
}

function attachPlan(state, journal) {
  const plan = upgradePlan();
  plan.source.providerRevisions = journal.sourceRevisions.map((source) => ({ providerId: source.providerId, revisions: [source.revision] }));
  const layers = journal.sourceRevisions.map((source) => {
    const values = journal.steps.filter((step) => step.target.providerId === source.providerId).map((step) => step.mutation.value);
    return upgradeLayerBinding(source.providerId, source.revision, { values: [] }, { values });
  });
  plan.source.dataDigests = layers.map((layer) => layer.source);
  plan.finalLayers = layers.map((layer) => layer.final);
  plan.steps = journal.steps.map((step) => ({ id: step.id, target: step.target,
    expectedRevision: journal.sourceRevisions.find((source) => source.providerId === step.target.providerId).revision,
    preDigest: step.preDigest, postDigest: step.postDigest, mutation: step.mutation, reversible: false }));
  const identified = identifyPlan(plan);
  journal.planId = identified.id;
  state.upgrades.plans = { [identified.id]: identified };
  state.upgrades.journal = { [journal.runId]: journal };
}

test("F1 declared same-authority data order cannot be repaired by sorting receipts", () => {
  const journal = orderedJournal();
  assert.deepEqual(readBuiltinRecoveryEnvelope(journal).steps.map((step) => step.mutation.value), [80, 999]);
  const reversed = structuredClone(journal); reversed.steps.reverse();
  assert.throws(() => readBuiltinRecoveryEnvelope(reversed), /declared authority execution order/);
  assert.deepEqual(reversed.steps.map((step) => step.mutation.value), [999, 80]);
});

test("F1 a matching reordered plan with a recomputed hash does not legitimize reversed data receipts", () => {
  const journal = orderedJournal(); const state = catalogState();
  attachPlan(state, journal);
  assert.equal(prepareBuiltinCatalog(state, binding, trustedAuthorities(journal.sourceRevisions)).configuration.upgrades.journal[journal.runId].phase, "completed");
  journal.steps.reverse(); attachPlan(state, journal);
  assert.throws(() => prepareBuiltinCatalog(state, binding, trustedAuthorities(journal.sourceRevisions)), /declared authority execution order/);
});

function bookkeeping(previous, operationId) {
  const request = { layer: previous.layer, expectedRevision: previous, operationId, mutation: { action: "set", key: "_weaver.upgrades.journal", value: {} } };
  return { operationId, previousRevision: previous, revision: { ...previous, sequence: String(BigInt(previous.sequence) + 1n) }, mutationDigest: computeProviderMutationDigest(request) };
}

function interleavedJournal() {
  const journal = completedJournal(); const first = journal.steps[0];
  const intent1 = bookkeeping(revision, first.intentOperationId);
  first.receipt = dataReceipt(first, intent1.revision);
  const completion1 = bookkeeping(first.receipt.revision, uuid("a"));
  const otherRevision = { ...revision, storeId: "fs:other", layer: "other" };
  const other = { ...structuredClone(first), id: "other", target: { ...first.target, providerId: "other", storeId: "fs:other", layer: "other" }, preRevision: otherRevision, operationId: uuid("9"), intentOperationId: uuid("c") };
  other.receipt = dataReceipt(other);
  const otherIntent = bookkeeping(completion1.revision, other.intentOperationId);
  const otherCompletion = bookkeeping(otherIntent.revision, uuid("d"));
  const second = nextStep(first, otherCompletion.revision);
  const intent2 = bookkeeping(second.preRevision, second.intentOperationId);
  second.receipt = dataReceipt(second, intent2.revision);
  const completion2 = bookkeeping(second.receipt.revision, uuid("b"));
  journal.steps = [first, other, second];
  journal.sourceRevisions = [{ providerId: "disk", revision }, { providerId: "other", revision: otherRevision }];
  journal.control = { providerId: "disk", revision, receipts: [intent1, completion1, otherIntent, otherCompletion, intent2, completion2], operationId: uuid("e") };
  journal.cursor = [{ providerId: "disk", revision: completion2.revision }, { providerId: "other", revision: other.receipt.revision }];
  return journal;
}

test("F1 interleaved providers and control bookkeeping preserve each authority's declared data order", () => {
  const journal = interleavedJournal();
  assert.deepEqual(readBuiltinRecoveryEnvelope(journal).steps.map((step) => step.id), ["s1", "other", "s2"]);
  const state = catalogState(); state.format.storeId = revision.storeId;
  state.infrastructure.generations.g1.providers.push({ id: "other", factory: "fs", options: { filePath: "/var/weaver/other.json" } });
  state.infrastructure.generations.g1.layout.layers.push({ name: "other", type: "static", providerId: "other", config: { mergeId: "deep" } });
  attachPlan(state, journal);
  assert.equal(prepareBuiltinCatalog(state, { ...binding, storeId: revision.storeId }, trustedAuthorities(journal.sourceRevisions)).configuration.upgrades.journal[journal.runId].cursor[0].revision.sequence, "9");
  const reversed = structuredClone(journal); reversed.steps.reverse();
  assert.throws(() => readBuiltinRecoveryEnvelope(reversed), /declared authority execution order/);
  attachPlan(state, reversed);
  assert.throws(() => prepareBuiltinCatalog(state, { ...binding, storeId: revision.storeId }, trustedAuthorities(reversed.sourceRevisions)), /declared authority execution order/);
});

test("F1 independent providers need no artificial global sequence ordering", () => {
  const journal = orderedJournal();
  const other = { ...structuredClone(journal.steps[0]), id: "other", operationId: uuid("9"), intentOperationId: uuid("c"),
    target: { ...journal.steps[0].target, providerId: "other", storeId: "fs:other", layer: "other" },
    preRevision: { ...revision, storeId: "fs:other", layer: "other", sequence: "20" } };
  other.receipt = dataReceipt(other);
  journal.sourceRevisions.push({ providerId: "other", revision: other.preRevision });
  journal.cursor.push({ providerId: "other", revision: other.receipt.revision });
  for (const steps of [[other, ...journal.steps], [journal.steps[0], other, journal.steps[1]], [...journal.steps, other]]) {
    assert.equal(readBuiltinRecoveryEnvelope({ ...journal, steps }).phase, "completed");
  }
});
