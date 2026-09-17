import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuiltinCatalogSource, internalConfigurationSchema, internalFormatSchema } from "@weaver-conf/config-types";
import { z } from "zod";
import { compileBuiltinContract } from "@weaver-conf/config-engine";
import { builtinCatalogReference, prepareBuiltinCatalog } from "../src/core/builtin-catalog.ts";
import { addRegistration, binding, catalogState, identifyPlan, registrationRecord, revision, trustedAuthorities, upgradePlan } from "./builtin-catalog-fixtures.mjs";

function storePlan(state, plan) {
  const identified = identifyPlan(plan);
  state.upgrades.plans = { [identified.id]: identified };
}

test("F2 a recomputed plan hash cannot authorize prod inventory/steps in a dev catalog", () => {
  const state = catalogState(); const plan = upgradePlan();
  const prod = { ...revision, environment: "prod" };
  plan.source.providerRevisions[0].revisions.push(prod);
  plan.steps = [{ id: "s1", target: { providerId: "disk", namespace: "fs:/var/weaver", storeId: revision.storeId, layer: revision.layer, path: "/svc/port" }, expectedRevision: prod, preDigest: "a".repeat(64), postDigest: "b".repeat(64), mutation: { action: "set", value: 80 }, reversible: false }];
  storePlan(state, plan);
  assert.throws(
    () => prepareBuiltinCatalog(state, binding, trustedAuthorities()),
    /Invalid built-in|inventory.*environment/,
  );
});

test("F2 every inventory entry, digest, provider and retained generation is bound", () => {
  const mutations = [
    (p) => { p.source.providerRevisions[0].revisions[0].environment = "prod"; },
    (p) => { p.source.providerRevisions.push(structuredClone(p.source.providerRevisions[0])); },
    (p) => { p.source.providerRevisions[0].revisions.push(structuredClone(p.source.providerRevisions[0].revisions[0])); },
    (p) => { p.source.providerRevisions[0].revisions.push({ ...revision, layer: "other", storeId: "foreign" }); },
    (p) => { p.source.dataDigests[0].storeId = "foreign"; },
    (p) => { p.source.dataDigests.push(structuredClone(p.source.dataDigests[0])); },
    (p) => { p.source.providerRevisions[0].providerId = "missing"; },
    (p) => { p.source.infrastructureGeneration = "missing"; },
    (p) => { p.finalLayers[0].namespace = "forged:alias"; },
  ];
  for (const mutate of mutations) {
    const state = catalogState(); const plan = structuredClone(upgradePlan()); mutate(plan); storePlan(state, plan);
    assert.throws(() => prepareBuiltinCatalog(state, binding, trustedAuthorities()), (error) => error.code === "VALIDATION_ERROR");
  }
});

test("F2 coordinated authority aliases cannot replace independently admitted identity", () => {
  const mutations = [
    (state, plan) => {
      plan.source.dataDigests[0].namespace = "forged:alias";
      plan.finalLayers[0].namespace = "forged:alias";
    },
    (state, plan) => {
      plan.source.providerRevisions[0].revisions[0].storeId = "forged:store";
      plan.source.dataDigests[0].storeId = "forged:store";
      plan.finalLayers[0].storeId = "forged:store";
    },
    (state, plan) => {
      plan.source.providerRevisions[0].revisions[0].environment = "prod";
      plan.finalLayers[0].environment = "prod";
    },
    (state, plan) => {
      state.infrastructure.generations.g1.layout.layers[0].name = "forged";
      plan.source.providerRevisions[0].revisions[0].layer = "forged";
      plan.source.dataDigests[0].layer = "forged";
      plan.finalLayers[0].layer = "forged";
    },
  ];
  for (const mutate of mutations) {
    const state = catalogState(); const plan = upgradePlan();
    mutate(state, plan); storePlan(state, plan);
    assert.throws(
      () => prepareBuiltinCatalog(state, binding, trustedAuthorities()),
      (error) => error.code === "VALIDATION_ERROR",
    );
  }
});

test("F2 admitted authority identity must be present exactly once", () => {
  const state = catalogState(); const plan = upgradePlan(); storePlan(state, plan);
  assert.throws(
    () => prepareBuiltinCatalog(state, binding, []),
    (error) => error.code === "VALIDATION_ERROR",
  );
  const authority = trustedAuthorities()[0];
  const { definition: _definition, ...missingDefinition } = authority;
  assert.throws(
    () => prepareBuiltinCatalog(state, binding, [missingDefinition]),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => prepareBuiltinCatalog(state, binding, [authority, structuredClone(authority)]),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("F2 one admitted provider may bind multiple canonical physical layers", () => {
  const state = catalogState(); const plan = upgradePlan();
  const scoped = { ...revision, layer: "platform:other", sequence: "2" };
  plan.source.providerRevisions[0].revisions.push(scoped);
  plan.source.dataDigests.push({
    ...structuredClone(plan.source.dataDigests[0]),
    layer: scoped.layer,
    digest: "d".repeat(64),
  });
  plan.finalLayers.push({
    ...structuredClone(plan.finalLayers[0]),
    layer: scoped.layer,
    sourceDigest: "d".repeat(64),
    finalDigest: "e".repeat(64),
  });
  plan.finalLayers.sort((left, right) =>
    JSON.stringify([left.providerId, left.layer]).localeCompare(
      JSON.stringify([right.providerId, right.layer]),
    ),
  );
  storePlan(state, plan);
  const authorities = trustedAuthorities([
    { providerId: "disk", revision },
    { providerId: "disk", revision: scoped },
  ]);
  assert.equal(
    prepareBuiltinCatalog(state, binding, authorities).configuration.upgrades
      .plans[identifyPlan(plan).id].finalLayers.length,
    2,
  );
});

test("F2 valid historical plans use retained generation identities, not active generation equality", () => {
  const state = catalogState(); const plan = upgradePlan();
  state.infrastructure.generations.g2 = structuredClone(state.infrastructure.generations.g1);
  state.infrastructure.generations.g2.providers[0].id = "newDisk";
  state.infrastructure.generations.g2.layout.layers[0].providerId = "newDisk";
  state.infrastructure.activeGeneration = "g2";
  storePlan(state, plan);
  assert.equal(prepareBuiltinCatalog(state, binding, trustedAuthorities()).configuration.infrastructure.activeGeneration, "g2");
  delete state.infrastructure.generations.g1;
  assert.throws(() => prepareBuiltinCatalog(state, binding, trustedAuthorities()), /not retained/);
});

test("F3 exported validator methods cannot substitute trusted preparation under an unchanged pin", () => {
  const source = getBuiltinCatalogSource(); const pin = builtinCatalogReference();
  const fake = () => ({ success: true, data: catalogState() });
  assert.throws(() => { source.contracts.configuration.schema.safeParse = fake; }, TypeError);
  const original = internalConfigurationSchema.safeParse;
  try {
    internalConfigurationSchema.safeParse = fake;
    assert.deepEqual(builtinCatalogReference(), pin);
    const bad = catalogState(); bad.catalog = { forged: true };
    assert.throws(() => prepareBuiltinCatalog(bad, binding), /Invalid built-in/);
  } finally { internalConfigurationSchema.safeParse = original; }
  assert.throws(() => { source.contracts.configuration.schema.jsonSchema.type = "string"; }, TypeError);
  const format = internalConfigurationSchema.shape.format;
  const version = internalFormatSchema.shape.version;
  try {
    internalConfigurationSchema.shape.format = z.unknown();
    internalFormatSchema.shape.version = z.unknown();
    const bad = catalogState(); bad.format.version = 2;
    assert.deepEqual(builtinCatalogReference(), pin);
    assert.throws(() => prepareBuiltinCatalog(bad, binding), /Invalid built-in/);
  } finally {
    internalConfigurationSchema.shape.format = format;
    internalFormatSchema.shape.version = version;
  }
});

test("F3 compiled schema maps expose immutable values and no mutable Map receiver", () => {
  const state = catalogState(); addRegistration(state, registrationRecord({ type: "object", properties: { port: { type: "integer", default: 80 } } }));
  const schemas = prepareBuiltinCatalog(state, binding).applicationSchemas;
  assert.equal(schemas.clear, undefined);
  assert.throws(() => Map.prototype.clear.call(schemas), TypeError);
  assert.throws(() => { schemas.get("/svc:dev").additionalProperties = true; }, TypeError);
  assert.throws(() => { [...schemas.values()][0].properties.port.default = 999; }, TypeError);
  schemas.forEach((value, key, view) => { assert.equal(view, schemas); assert.equal(value, schemas.get(key)); });
  assert.equal(schemas.size, 1);
});

test("F4 compilation checks actual strict leaf constraints without inventing mandatory siblings", () => {
  const source = getBuiltinCatalogSource();
  const invalid = [
    { ...source.contracts.format, defaults: { type: "object", properties: { initialization: { type: "string", default: "WRONG" } } } },
    { ...source.contracts.format, defaults: { type: "object", properties: { version: { type: "integer", default: 1 } } } },
    { ...source.contracts.generation, defaults: { type: "object", properties: { server: { type: "object", properties: { port: { type: "integer", default: 70000 } } } } } },
    { ...source.contracts.generation, defaults: { type: "object", properties: { server: { type: "object", properties: { corsOrigins: { type: "array", items: { type: "string", default: "not-a-url" } } } } } } },
  ];
  for (const definition of invalid) assert.throws(() => compileBuiltinContract(definition), /strict contract/);
  assert.equal(typeof compileBuiltinContract(source.contracts.format), "function");
  const optional = { ...source.contracts.generation, defaults: { type: "object", properties: { server: { type: "object", properties: { corsOrigins: { type: "array", default: [] } } } } } };
  assert.equal(typeof compileBuiltinContract(optional), "function");
  const missing = catalogState().format; delete missing.version;
  assert.throws(() => compileBuiltinContract(source.contracts.format)(missing), /Invalid built-in/);
});
