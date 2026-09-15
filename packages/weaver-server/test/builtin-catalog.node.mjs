import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BUILTIN_CATALOG_REFERENCE, builtinCatalogManifest, canonicalInternalJson, encodeInternalIdentity, getBuiltinCatalogSource, internalConfigurationSchema, internalRegistrationId } from "@weaver-conf/config-types";
import { compileBuiltinContract, compileInternalLayout, validateConfigurationDefaults } from "@weaver-conf/config-engine";
import { builtinCatalogReference, prepareBuiltinCatalog } from "../src/core/builtin-catalog.ts";
import { addRegistration, binding, catalogState, registrationRecord } from "./builtin-catalog-fixtures.mjs";

test("code catalog manifest is self-consistent, immutable and independent of runtime registration", () => {
  assert.equal(createHash("sha256").update(canonicalInternalJson(builtinCatalogManifest())).digest("hex"), BUILTIN_CATALOG_REFERENCE.digest);
  assert.deepEqual(builtinCatalogReference(), BUILTIN_CATALOG_REFERENCE);
  const source = getBuiltinCatalogSource();
  assert.throws(() => { source.contracts.format.defaults.properties.initialization.default = "initialized"; }, TypeError);
  assert.throws(() => { source.contracts.format = {}; }, TypeError);
  for (const definition of Object.values(source.contracts)) {
    assert.equal(validateConfigurationDefaults(definition.defaults).valid, true);
    assert.equal(typeof compileBuiltinContract(definition), "function");
  }
  const prepared = prepareBuiltinCatalog(catalogState(), binding);
  assert.equal(prepared.applicationSchemas.size, 0);
  assert.deepEqual(prepared.layout.layerNames, ["platform"]);
  assert.equal(prepared.layout.getRank("platform"), 0);
  assert.throws(() => { prepared.configuration.infrastructure.generations.g1.providers[0].options.filePath = "/tmp/evil"; }, TypeError);
});

test("typed defaults are materialized on the validated returned object without mutating caller data", () => {
  const state = catalogState();
  delete state.infrastructure.generations.g1.server.port;
  delete state.infrastructure.generations.g1.server.auth.adminRoles;
  const before = structuredClone(state);
  const { configuration } = prepareBuiltinCatalog(state, binding);
  assert.equal(internalConfigurationSchema.safeParse(configuration).success, true);
  assert.equal(configuration.format.version, 1);
  assert.equal(configuration.infrastructure.generations.g1.server.port, 3399);
  assert.deepEqual(configuration.infrastructure.generations.g1.server.auth.adminRoles, ["admin"]);
  assert.deepEqual(state, before);
  const invalid = catalogState(); invalid.infrastructure.generations.g1.server.port = null;
  assert.throws(() => prepareBuiltinCatalog(invalid, binding), /Invalid built-in/);
});

test("missing/uninitialized/tampered catalogs cannot produce a prepared application catalog", () => {
  const mutations = [
    (s) => { delete s.catalog; }, (s) => { delete s.catalog.registrations; },
    (s) => { delete s.format.version; }, (s) => { delete s.infrastructure.generations.g1.version; },
    (s) => { s.format.initialization = "uninitialized"; }, (s) => { delete s.format.initialization; },
    (s) => { s.format.builtinCatalog.id = "forged"; }, (s) => { s.format.builtinCatalog.version++; },
    (s) => { s.format.builtinCatalog.digest = "0".repeat(64); }, (s) => { s.format.storeId = "other"; },
    (s) => { s.format.environment = "other"; }, (s) => { s.catalog.schemas = { "_weaver": {} }; },
    (s) => { s.builtinSchemas = {}; }, (s) => { s.registry = { schemas: {} }; },
    (s) => { s.infrastructure.activeGeneration = "toString"; },
    (s) => { s.infrastructure.activeGeneration = "valueOf"; },
  ];
  for (const mutate of mutations) {
    const state = catalogState(); mutate(state);
    assert.throws(() => prepareBuiltinCatalog(state, binding), (error) => ["VALIDATION_ERROR", "SERVER_DEGRADED"].includes(error.code));
  }
  for (const raw of [undefined, null, {}, { catalog: { registrations: {} } }]) assert.throws(() => prepareBuiltinCatalog(raw, binding));
});

test("registration records own canonical identities and compile real parent/slot schemas", () => {
  const state = catalogState();
  const service = registrationRecord(); service.request.fragmentSlots = [{ slotPath: "/plugins", accepts: "object" }];
  addRegistration(state, service);
  const fragment = { version: 1, kind: "fragment", request: { serviceId: "svc", environment: "dev", providerId: "analytics", slotPath: "/plugins", owner: service.request.owner, schema: { type: "object", properties: { enabled: { type: "boolean", default: false } } } }, audit: { actor: "admin" } };
  addRegistration(state, fragment);
  assert.equal(internalRegistrationId(service), Buffer.from(JSON.stringify(["dev", "service", "svc", "", ""])).toString("hex"));
  const prepared = prepareBuiltinCatalog(state, binding);
  assert.equal(prepared.applicationSchemas.get("/svc:dev").properties.plugins.additionalProperties, false);
  assert.equal(prepared.applicationSchemas.get("/svc:dev").properties.plugins.properties.analytics.properties.enabled.default, false);
  const bad = structuredClone(state); bad.catalog.registrations.ff = bad.catalog.registrations[internalRegistrationId(service)];
  assert.throws(() => prepareBuiltinCatalog(bad, binding), /Invalid built-in/);
  const orphan = catalogState(); addRegistration(orphan, fragment);
  assert.throws(() => prepareBuiltinCatalog(orphan, binding), /Orphan/);
});

test("unsupported grammar and invalid optional defaults in records refuse before catalog preparation", () => {
  for (const schema of [
    { type: "object", properties: { unused: { type: "object", oneOf: [{ type: "object" }] } } },
    { type: "object", properties: { unused: { type: "integer", default: "bad" } } },
    { type: "object", properties: { unused: { type: "object", default: {}, properties: { _weaver: { type: "string", default: "secret-ref" } } } } },
  ]) {
    const state = catalogState(); addRegistration(state, registrationRecord(schema));
    assert.throws(() => prepareBuiltinCatalog(state, binding));
  }
  const state = catalogState(); addRegistration(state, registrationRecord({ type: "object", properties: { ordinaryOptional: { type: "string" } } }));
  assert.equal(prepareBuiltinCatalog(state, binding).applicationSchemas.size, 1);
});

test("malformed registration children and serialized executable factories reject with typed errors", () => {
  for (const mutate of [
    (record) => { record.version = 2; }, (record) => { record.kind = "fragment"; },
    (record) => { record.audit = {}; }, (record) => { record.canonicalPath = "/other"; },
    (record) => { record.request.schema = { type: "array" }; },
  ]) {
    const state = catalogState(); const record = registrationRecord();
    addRegistration(state, record); mutate(record);
    assert.throws(() => prepareBuiltinCatalog(state, binding), (error) => error.code === "VALIDATION_ERROR");
  }
  const state = catalogState(); state.infrastructure.generations.g1.providers[0].options.factory = () => {};
  assert.throws(() => prepareBuiltinCatalog(state, binding), (error) => error.code === "VALIDATION_ERROR");
});

test("allowlisted provider contracts permit references but reject credential URL and malformed option payloads", () => {
  const valid = [
    { id: "disk", factory: "git", options: { localPath: "/var/weaver", filePath: "control.json", authority: "local-durable", remote: "https://example.test/config.git" }, credentials: { token: "gitToken" } },
    { id: "disk", factory: "mongodb", options: { database: "weaver", collection: "config" }, credentials: { connection: "mongoConnection" } },
    { id: "disk", factory: "memory", options: { durability: "volatile" } },
  ];
  for (const provider of valid) {
    const state = catalogState(); state.infrastructure.generations.g1.providers = [provider];
    assert.equal(prepareBuiltinCatalog(state, binding).configuration.infrastructure.generations.g1.providers[0].factory, provider.factory);
  }
  for (const remote of ["not-a-url", "https://token@example.test/config.git", "https://example.test/config.git?token=secret", "file:///tmp/config.git"]) {
    const state = catalogState(); const provider = structuredClone(valid[0]); provider.options.remote = remote;
    state.infrastructure.generations.g1.providers = [provider];
    assert.throws(() => prepareBuiltinCatalog(state, binding), (error) => error.code === "VALIDATION_ERROR");
  }
});

test("layout graph, provider IDs/options and server credential references are closed contracts", () => {
  const mutations = [
    (g) => { g.layout.layers.push(structuredClone(g.layout.layers[0])); },
    (g) => { g.layout.layers[0].providerId = "missing"; }, (g) => { g.layout.layers[0].config.mergeId = "custom"; },
    (g) => { g.layout.layers[0].rank = 99; }, (g) => { g.providers[0].factory = "import:/tmp/evil"; },
    (g) => { g.providers[0].options.password = "secret"; }, (g) => { g.server.auth.credentialRef = { _weaver: "secret-ref" }; },
    (g) => { g.layout.scopes = [{ id: "a", label: "A", parentScopeId: "b" }, { id: "b", label: "B", parentScopeId: "a" }]; },
    (g) => { g.layout.scopes = [{ id: "a", label: "A", parentScopeId: "missing" }]; },
  ];
  for (const mutate of mutations) {
    const state = catalogState(); mutate(state.infrastructure.generations.g1);
    assert.throws(() => prepareBuiltinCatalog(state, binding));
  }
  for (const type of ["personal", "ephemeral"]) {
    const state = catalogState(); state.infrastructure.generations.g1.layout.layers[0].type = type;
    assert.throws(() => prepareBuiltinCatalog(state, binding), /no installed resolver/);
  }
});

test("full scope vectors use existing canonical identities and the declared hierarchy", () => {
  const state = catalogState(); const g = state.infrastructure.generations.g1;
  g.layout.scopes = [{ id: "region", label: "Region" }, { id: "tenant", label: "Tenant", parentScopeId: "region" }];
  g.layout.layers.push({ name: "tenant", type: "dynamic", providerId: "disk", config: { mergeId: "deep", scopeIds: ["region", "tenant"] } });
  const region = [{ scopeId: "region", value: "eu" }]; const full = [...region, { scopeId: "tenant", value: "one" }];
  for (const scopePath of [region, full]) state.scopeInventory.contexts[encodeInternalIdentity(scopePath.map(({ scopeId, value }) => [scopeId, value]))] = { scopePath, state: "active" };
  const prepared = prepareBuiltinCatalog(state, binding);
  assert.equal(prepared.layout.getRank("tenant"), 1);
  assert.equal(prepared.layout.getLayer("tenant").type.id, "dynamic");
  const merge = prepared.layout.getLayer("tenant").type.defaultMerge;
  assert.deepEqual(merge({ list: [1], keep: true }, { list: [2] }), { list: [2], keep: true });
  const bad = structuredClone(state); delete bad.scopeInventory.contexts[encodeInternalIdentity([["region", "eu"]])];
  assert.throws(() => prepareBuiltinCatalog(bad, binding), /Invalid built-in/);
  const wrong = structuredClone(g.layout); wrong.layers[1].config.scopeIds.reverse();
  assert.throws(() => compileInternalLayout(wrong));
});
