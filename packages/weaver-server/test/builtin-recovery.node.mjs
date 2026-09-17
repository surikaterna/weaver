import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_CATALOG_REFERENCE, canonicalInternalJson, getBuiltinCatalogSource, internalUpgradeTargetSchema } from "@weaver-conf/config-types";
import { compileBuiltinContract } from "@weaver-conf/config-engine";
import { assertSupportedSourceBuiltinCatalog, prepareBuiltinCatalog, readBuiltinRecoveryEnvelope } from "../src/core/builtin-catalog.ts";
import { binding, catalogState, completedJournal, recoveryEnvelope, revision, trustedAuthorities, upgradePlan } from "./builtin-catalog-fixtures.mjs";

test("pinned recovery is readable with invalid, missing or partially migrated target catalog", () => {
  const journal = recoveryEnvelope();
  const recovered = readBuiltinRecoveryEnvelope(journal);
  assert.deepEqual(recovered, journal);
  assert.deepEqual(recovered.source, BUILTIN_CATALOG_REFERENCE);
  assert.doesNotThrow(() => assertSupportedSourceBuiltinCatalog(recovered.source));
  const state = catalogState(); state.catalog = { unsupportedFutureCatalog: true };
  state.upgrades.journal[journal.runId] = journal;
  assert.throws(() => prepareBuiltinCatalog(state, binding));
  assert.equal(readBuiltinRecoveryEnvelope(state.upgrades.journal[journal.runId]).target.version, 99);
  assert.equal(canonicalInternalJson(journal), canonicalInternalJson(readBuiltinRecoveryEnvelope(journal)));
});

test("recovery phase/status discriminants reject contradictory fields and permit raw references", () => {
  const journal = recoveryEnvelope();
  const step = { id: "s1", target: { providerId: "disk", namespace: "fs:/var/weaver", storeId: revision.storeId, layer: revision.layer, path: "/svc/token" }, operationId: "44444444-4444-4444-8444-444444444444", preRevision: revision, preDigest: "a".repeat(64), postDigest: "b".repeat(64), mutation: { action: "set", value: { _weaver: "secret-ref", provider: "vault", uri: "raw-reference" } }, status: "pending" };
  journal.steps = [step];
  assert.deepEqual(readBuiltinRecoveryEnvelope(journal).steps[0].mutation.value, step.mutation.value);
  for (const mutate of [
    (j) => { j.version = 2; }, (j) => { j.phase = "completed"; }, (j) => { j.phase = "blocked"; },
    (j) => { j.steps[0].status = "complete"; }, (j) => { j.steps[0].intentOperationId = step.operationId; },
    (j) => { j.steps[0].target.storeId = "other"; }, (j) => { j.steps.push(structuredClone(j.steps[0])); },
    (j) => { j.validator = "stored-shadow"; },
  ]) {
    const bad = structuredClone(journal); mutate(bad);
    assert.throws(() => readBuiltinRecoveryEnvelope(bad));
  }
});

test("plan body and record identities are bound while recovery does not depend on plan readability", () => {
  const state = catalogState(); const plan = upgradePlan(); const journal = recoveryEnvelope();
  state.upgrades.plans[plan.id] = plan; state.upgrades.journal[journal.runId] = journal;
  assert.equal(prepareBuiltinCatalog(state, binding, trustedAuthorities()).configuration.upgrades.plans[plan.id].id, plan.id);
  const bad = structuredClone(state); bad.upgrades.plans[plan.id].source.inventoryRevision = "1";
  assert.throws(() => prepareBuiltinCatalog(bad, binding, trustedAuthorities()), /Invalid built-in|plan body digest/);
  assert.equal(readBuiltinRecoveryEnvelope(bad.upgrades.journal[journal.runId]).phase, "prepared");
  const missing = structuredClone(state); missing.upgrades.plans = {};
  assert.throws(() => prepareBuiltinCatalog(missing, binding, trustedAuthorities()), /missing plan/);
});

test("code-contract compilation refuses invalid or marker-bearing default annotations", () => {
  const definition = getBuiltinCatalogSource().contracts.format;
  for (const child of [{ type: "integer", default: "bad" }, { type: "object", default: {}, properties: { _weaver: { type: "string", default: "mount" } } }, { type: "object", allOf: [{ type: "object" }] }]) {
    assert.throws(() => compileBuiltinContract({ ...definition, defaults: { type: "object", properties: { unused: child } } }));
  }
});

test("completed recovery requires coherent receipt lineage and bounded envelopes", () => {
  const journal = completedJournal();
  assert.equal(readBuiltinRecoveryEnvelope(journal).phase, "completed");
  for (const mutate of [
    (j) => { j.steps[0].receipt.operationId = j.runId; },
    (j) => { j.steps[0].receipt.previousRevision.storeId = "other"; },
    (j) => { j.steps[0].receipt.revision.sequence = "4"; },
    (j) => { j.steps[0].receipt.revision.sequence = "bad"; },
    (j) => { j.steps[0].mutation.value = "x".repeat(4_000_001); },
  ]) {
    const bad = structuredClone(journal); mutate(bad);
    assert.throws(() => readBuiltinRecoveryEnvelope(bad), (error) => error.code === "VALIDATION_ERROR");
  }
});

test("upgrade targets preserve canonical Unicode/internal paths without admitting aliases or prototype segments", () => {
  const target = { providerId: "disk", namespace: "fs:/var/weaver", storeId: "fs:data", layer: "platform" };
  for (const path of ["/svc/título", "/_weaver/format", "/svc/a.b"]) assert.equal(internalUpgradeTargetSchema.safeParse({ ...target, path }).success, true);
  for (const path of ["svc/x", "/", "/svc/", "/svc//x", "/svc/[x]", "/svc/__proto__", "/svc/constructor"]) assert.equal(internalUpgradeTargetSchema.safeParse({ ...target, path }).success, false);
});
