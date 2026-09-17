import assert from "node:assert/strict";
import {
  canonicalInternalJson,
  internalConfigurationSchema,
} from "@weaver-conf/config-types";

const authorityIdentityFields = [
  "storageFormat",
  "storeId",
  "environment",
  "layer",
  "epoch",
];

export function preservationSnapshot(envelope, selectedPlanId, runId) {
  const snapshot = structuredClone(envelope);
  delete snapshot.sequence;
  delete snapshot.lastCommit;
  delete snapshot.entries._weaver.upgrades.plans[selectedPlanId];
  delete snapshot.entries._weaver.upgrades.journal[runId];
  internalConfigurationSchema.parse(snapshot.entries._weaver);
  return JSON.parse(canonicalInternalJson(snapshot));
}

export function expectedCompletedEnvelope(envelope, selectedPlanId, runId) {
  const expected = structuredClone(envelope);
  const root = expected.entries._weaver;
  const plan = root.upgrades.plans[selectedPlanId];
  const journal = root.upgrades.journal[runId];
  assert.ok(plan?.target.registrations, "selected target catalog available");
  assert.ok(journal?.target, "selected target format available");
  root.catalog = { registrations: structuredClone(plan.target.registrations) };
  root.format.builtinCatalog = structuredClone(journal.target);
  internalConfigurationSchema.parse(root);
  return expected;
}

export function assertPreservationCoverage(
  expected,
  selectedPlanId,
  runId,
  unrelated,
) {
  const root = expected.entries._weaver;
  assert.deepEqual(Object.keys(root).sort(), [
    "catalog",
    "format",
    "infrastructure",
    "scopeInventory",
    "upgrades",
  ]);
  assert.ok(
    Object.keys(root.catalog.registrations).length > 0,
    "catalog populated",
  );
  assert.ok(
    root.infrastructure.generations[unrelated.generationId],
    "generation included",
  );
  assert.ok(root.upgrades.plans[unrelated.planId], "unrelated plan included");
  assert.ok(root.upgrades.journal[unrelated.runId], "unrelated journal included");
  assert.equal(
    root.upgrades.plans[selectedPlanId],
    undefined,
    "selected plan excluded",
  );
  assert.equal(root.upgrades.journal[runId], undefined, "selected journal excluded");
  assert.equal(Object.hasOwn(expected, "sequence"), false, "sequence excluded");
  assert.equal(Object.hasOwn(expected, "lastCommit"), false, "lastCommit excluded");
}

export function assertPreservedControl(
  actual,
  baseline,
  expected,
  selectedPlanId,
  runId,
  label,
) {
  for (const field of authorityIdentityFields)
    assert.equal(
      actual[field],
      baseline[field],
      `${label}: immutable authority ${field}`,
    );
  assert.deepEqual(
    preservationSnapshot(actual, selectedPlanId, runId),
    expected,
    `${label}: complete untouched control state`,
  );
}
