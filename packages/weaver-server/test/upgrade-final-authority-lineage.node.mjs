import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { canonicalInternalJson, internalUpgradeLayerDigest, internalUpgradePlanSchema } from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import {
  assertFinalLayerEvidence,
  finalLayerKey,
  validateFinalAuthorityLineage,
} from "../src/core/final-authority-lineage.ts";

const baseline = {
  storeId: "fs:data",
  environment: "dev",
  layer: "application",
  epoch: "11111111-1111-4111-8111-111111111111",
  sequence: "8",
};
const namespace = "fs:/tmp/data.json";
const sourceEntries = { svc: { keep: true } };
const finalEntries = { svc: { keep: true, port: 80 } };

test("exact unchanged baseline and exact completed receipt tips pass", () => {
  const { plan, journal, envelope } = fixture();
  const lineage = validateFinalAuthorityLineage(plan, journal);
  const expected = lineage.get(finalLayerKey("data", "application"));
  assert.ok(expected);
  assert.doesNotThrow(() =>
    assertFinalLayerEvidence(expected, "data", namespace, envelope, false),
  );
  const unchanged = unchangedFixture();
  const unchangedLineage = validateFinalAuthorityLineage(
    unchanged.plan,
    unchanged.journal,
  );
  const unchangedExpected = unchangedLineage.get(
    finalLayerKey("data", "application"),
  );
  assert.ok(unchangedExpected);
  assert.doesNotThrow(() =>
    assertFinalLayerEvidence(
      unchangedExpected,
      "data",
      namespace,
      unchanged.envelope,
      false,
    ),
  );
});

test("unrecorded revision and same-revision content divergence fail typed", () => {
  const { plan, journal, envelope } = fixture();
  const expected = validateFinalAuthorityLineage(plan, journal).get(
    finalLayerKey("data", "application"),
  );
  assert.ok(expected);
  rejectsValidation(() =>
    assertFinalLayerEvidence(
      expected,
      "data",
      namespace,
      { ...envelope, sequence: "10" },
      false,
    ),
  );
  rejectsValidation(() =>
    assertFinalLayerEvidence(
      expected,
      "data",
      namespace,
      { ...envelope, entries: { svc: { keep: false, port: 80 } } },
      false,
    ),
  );
});

test("journal and receipt identity, digest, lineage, order, and cursor mismatches fail", () => {
  const mutations = [
    (value) => (value.planId = "f".repeat(64)),
    (value) => (value.steps[0].id = "foreign"),
    (value) => (value.steps[0].mutation.value.port = 81),
    (value) => (value.steps[0].preDigest = "f".repeat(64)),
    (value) => (value.steps[0].postDigest = "f".repeat(64)),
    (value) => (value.steps[0].operationId = randomUUID()),
    (value) => (value.steps[0].receipt.operationId = randomUUID()),
    (value) => (value.steps[0].receipt.mutationDigest = "f".repeat(64)),
    (value) => (value.steps[0].receipt.previousRevision.sequence = "7"),
    (value) => (value.steps[0].receipt.revision.sequence = "11"),
    (value) => (value.steps[0].receipt.revision.epoch = randomUUID()),
    (value) => (value.cursor[0].revision.sequence = "8"),
    (value) => value.cursor.push(structuredClone(value.cursor[0])),
    (value) => value.cursor.splice(0, 1),
    (value) => value.sourceRevisions.splice(0, 1),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const { plan, journal } = fixture();
    const candidate = structuredClone(journal);
    mutate(candidate);
    assert.throws(
      () => validateFinalAuthorityLineage(plan, candidate),
      { code: "VALIDATION_ERROR" },
      `mutation ${index}`,
    );
  }
});

test("persisted plan without final bindings is strictly rejected", () => {
  const { plan } = fixture();
  const missing = structuredClone(plan);
  delete missing.finalLayers;
  assert.equal(internalUpgradePlanSchema.safeParse(missing).success, false);
});

function fixture() {
  const operationId = "22222222-2222-4222-8222-222222222222";
  const mutation = { action: "set", value: finalEntries.svc };
  const stepBody = {
    target: {
      providerId: "data",
      namespace,
      storeId: baseline.storeId,
      layer: baseline.layer,
      path: "/svc",
    },
    expectedRevision: baseline,
    preDigest: digest({ absent: false, value: sourceEntries.svc }),
    postDigest: digest({ absent: false, value: finalEntries.svc }),
    mutation,
    reversible: true,
    undo: { action: "set", value: sourceEntries.svc },
  };
  const step = { id: `s${digest(stepBody).slice(0, 31)}`, ...stepBody };
  const plan = identify({
    version: 1,
    source: sourceBinding(),
    target: { catalogDigest: "c".repeat(64) },
    contexts: [[]],
    steps: [step],
    finalLayers: [finalBinding(sourceEntries, finalEntries)],
    refusals: [],
  });
  const receipt = {
    operationId,
    previousRevision: baseline,
    revision: { ...baseline, sequence: "9" },
    mutationDigest: computeProviderMutationDigest({
      layer: baseline.layer,
      expectedRevision: baseline,
      operationId,
      mutation: { action: "set", key: "svc", value: finalEntries.svc },
    }),
  };
  const recorded = {
    id: step.id,
    target: step.target,
    operationId,
    preRevision: baseline,
    preDigest: step.preDigest,
    postDigest: step.postDigest,
    mutation,
    undo: step.undo,
    status: "complete",
    intentOperationId: "33333333-3333-4333-8333-333333333333",
    receipt,
  };
  const journal = journalFor(plan, [recorded], receipt.revision);
  return { plan, journal, envelope: envelope(receipt.revision, finalEntries, receipt) };
}

function unchangedFixture() {
  const plan = identify({ version: 1, source: sourceBinding(), target: { catalogDigest: "c".repeat(64) }, contexts: [[]], steps: [], finalLayers: [finalBinding(sourceEntries, sourceEntries)], refusals: [] });
  return { plan, journal: journalFor(plan, [], baseline), envelope: envelope(baseline, sourceEntries) };
}

function sourceBinding() {
  return { catalogDigest: "a".repeat(64), dataDigests: [{ providerId: "data", namespace, storeId: baseline.storeId, layer: baseline.layer, contentDomain: "layer-entries-v1", digest: internalUpgradeLayerDigest(sourceEntries, "layer-entries-v1") }], providerRevisions: [{ providerId: "data", revisions: [baseline] }], inventoryRevision: "0", infrastructureGeneration: "g1" };
}

function finalBinding(source, final) {
  return { providerId: "data", namespace, storeId: baseline.storeId, environment: baseline.environment, layer: baseline.layer, contentDomain: "layer-entries-v1", sourceDigest: internalUpgradeLayerDigest(source, "layer-entries-v1"), finalDigest: internalUpgradeLayerDigest(final, "layer-entries-v1") };
}

function journalFor(plan, steps, revision) {
  return { version: 1, runId: "44444444-4444-4444-8444-444444444444", planId: plan.id, source: { id: "weaver.internal", version: 7, digest: "e".repeat(64) }, target: { id: "weaver.internal", version: 7, digest: "e".repeat(64) }, infrastructureGeneration: "g1", owner: "55555555-5555-4555-8555-555555555555", phase: "verifying", sourceRevisions: [{ providerId: "data", revision: baseline }], cursor: [{ providerId: "data", revision }], steps };
}

function envelope(revision, entries, lastCommit) {
  return { storageFormat: 1, ...revision, entries, ...(lastCommit ? { lastCommit } : {}) };
}

function identify(body) {
  return { ...body, id: digest(body) };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}

function rejectsValidation(run) {
  assert.throws(run, { code: "VALIDATION_ERROR" });
}
