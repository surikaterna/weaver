import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildUpgradePlan } from "../src/index.ts";
import { placeUpgradeDefaults } from "../src/upgrade-placement.ts";
import { canonicalInternalJson, encodeInternalIdentity, internalRegistrationId, internalUpgradeLayerDigest, internalUpgradePlanSchema, sha256Hex } from "@weaver-conf/config-types";

const revision = { storeId: "fs:data", environment: "dev", layer: "base", epoch: "11111111-1111-4111-8111-111111111111", sequence: "1" };
function record(schema) {
  return { version: 1, kind: "service", request: { serviceId: "svc", environment: "dev", owner: { name: "Service", contact: "ops@example.test" }, schema, fragmentSlots: [] }, audit: { actor: "admin" } };
}
function catalog(schema) {
  const value = record(schema);
  return { registrations: { [internalRegistrationId(value)]: value } };
}
function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
function input(sourceSchema, targetSchema, entries = {}, overrides = {}) {
  const sourceCatalog = catalog(sourceSchema);
  const targetCatalog = catalog(targetSchema);
  const sourceCatalogDigest = digest(sourceCatalog);
  const targetCatalogDigest = digest(targetCatalog);
  return {
    version: 1,
    request: { version: 1, expectedAuthorityRevision: "authority-v1.fixed", sourceCatalogDigest, inventoryRevision: "0", infrastructureGeneration: "g1", target: { catalogDigest: targetCatalogDigest, registrations: targetCatalog.registrations } },
    authorityRevision: "authority-v1.fixed",
    sourceCatalog,
    sourceCatalogDigest,
    targetCatalog,
    targetCatalogDigest,
    schemas: [{ path: "/svc", environment: "dev", source: sourceSchema, target: targetSchema }],
    inventory: { version: 1, revision: "0", contexts: {} },
    infrastructureGenerationId: "g1",
    infrastructure: { version: 1, layout: { layers: [{ name: "base", type: "static", providerId: "disk", config: { mergeId: "deep" } }], scopes: [] }, providers: [{ id: "disk", factory: "fs", options: { filePath: "/tmp/data.json" } }], server: { port: 3399, auth: { credentialRef: "jwt", adminRoles: ["admin"] } } },
    providers: [{ providerId: "disk", namespace: "fs:/tmp/data.json", writable: true, capabilities: { kind: "durable-exclusive", durability: "local-fsync", namespace: "fs:/tmp/data.json", maxEnvelopeBytes: 100000, scopedIO: "complete" }, layers: [{ revision, entries }] }],
    ...overrides,
  };
}

test("required and optional own defaults produce one deterministic anchor replacement", () => {
  const source = { type: "object", properties: { keep: { type: "boolean" } } };
  const target = { type: "object", default: {}, required: ["port"], properties: { keep: { type: "boolean" }, port: { type: "integer", default: 80 }, label: { type: "string", default: "" }, flags: { type: "array", default: [] } } };
  const value = input(source, target, { svc: { keep: false } });
  const first = buildUpgradePlan(value);
  const reordered = structuredClone(value); reordered.providers[0].layers[0].entries = { svc: { keep: false } };
  const second = buildUpgradePlan(reordered);
  assert.equal(first.status, "ready");
  assert.deepEqual(first, second);
  assert.equal(canonicalInternalJson(first), canonicalInternalJson(second));
  assert.deepEqual(first.plan.steps[0].mutation.value, { keep: false, flags: [], label: "", port: 80 });
  assert.equal(first.plan.steps[0].target.namespace, "fs:/tmp/data.json");
  assert.deepEqual(first.plan.steps[0].expectedRevision, revision);
  assert.equal(first.plan.steps[0].postDigest, sha256Hex(canonicalInternalJson({ absent: false, value: first.plan.steps[0].mutation.value })));
  assert.deepEqual(first.plan.finalLayers, [{
    providerId: "disk", namespace: "fs:/tmp/data.json", storeId: "fs:data", environment: "dev", layer: "base",
    contentDomain: "layer-entries-v1",
    sourceDigest: internalUpgradeLayerDigest({ svc: { keep: false } }, "layer-entries-v1"),
    finalDigest: internalUpgradeLayerDigest({ svc: first.plan.steps[0].mutation.value }, "layer-entries-v1"),
  }]);
});

test("final layer bindings are complete, deterministic, and part of plan identity", () => {
  const source = { type: "object", properties: { keep: { type: "boolean" } } };
  const target = { type: "object", default: {}, properties: { keep: { type: "boolean" }, port: { type: "integer", default: 80 } } };
  const unchangedRevision = { ...revision, storeId: "fs:other", layer: "other", epoch: "22222222-2222-4222-8222-222222222222" };
  const value = input(source, target, { svc: { keep: true } });
  value.infrastructure.layout.layers.push({ name: "other", type: "static", providerId: "other", config: { mergeId: "deep" } });
  value.infrastructure.providers.push({ id: "other", factory: "fs", options: { filePath: "/tmp/other.json" } });
  value.providers.push({ providerId: "other", namespace: "fs:/tmp/other.json", writable: true, capabilities: { kind: "durable-exclusive", durability: "local-fsync", namespace: "fs:/tmp/other.json", maxEnvelopeBytes: 100000, scopedIO: "complete" }, layers: [{ revision: unchangedRevision, entries: { untouched: true } }] });
  const first = buildUpgradePlan(value);
  const reordered = structuredClone(value); reordered.providers.reverse();
  const second = buildUpgradePlan(reordered);
  assert.equal(first.status, "ready");
  assert.deepEqual(first, second);
  assert.equal(first.plan.finalLayers.length, 2);
  const unchanged = first.plan.finalLayers.find((layer) => layer.providerId === "other");
  assert.equal(unchanged.sourceDigest, unchanged.finalDigest);
  const changed = structuredClone(first.plan);
  changed.finalLayers[0].finalDigest = "f".repeat(64);
  assert.equal(internalUpgradePlanSchema.safeParse(changed).success, false);
  const { id: _id, ...changedBody } = changed;
  assert.notEqual(digest(changedBody), first.plan.id);
});

test("control final digests exclude only protected metadata", () => {
  const first = { application: { enabled: true }, _weaver: { revision: 1 } };
  const metadataChanged = { ...first, _weaver: { revision: 99 } };
  const applicationChanged = { ...first, application: { enabled: false } };
  const digest = internalUpgradeLayerDigest(first, "control-application-v1");
  assert.equal(
    digest,
    internalUpgradeLayerDigest(metadataChanged, "control-application-v1"),
  );
  assert.notEqual(
    digest,
    internalUpgradeLayerDigest(applicationChanged, "control-application-v1"),
  );
});

test("nested insertion requires an explicit complete parent object default", () => {
  const source = { type: "object" };
  const blocked = { type: "object", properties: { nested: { type: "object", properties: { leaf: { type: "string", default: "x" } } } } };
  assert.equal(buildUpgradePlan(input(source, blocked)).refusals[0].code, "missing-default");
  const target = { type: "object", default: {}, properties: { nested: { type: "object", default: { leaf: "x" }, required: ["leaf"], properties: { leaf: { type: "string", default: "x" } } } } };
  const result = buildUpgradePlan(input(source, target));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.plan.steps[0].mutation.value, { nested: { leaf: "x" } });
});

test("optional becoming required uses its own target default", () => {
  const source = { type: "object", properties: { value: { type: "string" } } };
  const target = { type: "object", default: { value: "required" }, required: ["value"], properties: { value: { type: "string", default: "required" } } };
  const result = buildUpgradePlan(input(source, target));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.plan.steps[0].mutation.value, { value: "required" });
  const missing = structuredClone(target); delete missing.properties.value.default;
  assert.equal(buildUpgradePlan(input(source, missing)).refusals[0].code, "missing-default");
});

test("explicit null, scalar and array anchors refuse instead of being replaced", () => {
  const source = { type: "object" };
  const target = { type: "object", properties: { added: { type: "string", default: "x" } } };
  for (const anchor of [null, false, 0, "", []]) {
    const result = buildUpgradePlan(input(source, target, { svc: anchor }));
    assert.equal(result.status, "blocked");
    assert.equal(result.refusals[0].code, "unsafe-overwrite");
  }
});

test("a non-object ancestor cannot be materialized by a nested anchor plan", () => {
  const root = { type: "object", default: {}, properties: { added: { type: "string", default: "x" } } };
  const value = input({ type: "object" }, { type: "object" }, { svc: null });
  const result = placeUpgradeDefaults(value, [{ anchor: "/svc/nested", path: ["added"], value: "x", schema: root.properties.added, rootSchema: root }]);
  assert.equal(result.anchors.length, 0);
  assert.equal(result.refusals[0].code, "unsafe-overwrite");
});

test("full-anchor replacement refuses sensitive existing siblings without disclosure", () => {
  const source = { type: "object", properties: { password: { type: "string", "x-weaver": { sensitive: true } } } };
  const target = { type: "object", properties: { password: { type: "string", "x-weaver": { sensitive: true } }, added: { type: "string", default: "x" } } };
  const result = buildUpgradePlan(input(source, target, { svc: { password: "TOPSECRET" } }));
  assert.equal(result.status, "blocked");
  assert.equal(result.refusals[0].code, "unverifiable-secret");
  assert.equal(canonicalInternalJson(result).includes("TOPSECRET"), false);
});

test("nested and pattern-governed sensitive siblings block full-anchor serialization", () => {
  const source = { type: "object", properties: { nested: { type: "object", properties: { token: { type: "string", "x-weaver": { sensitive: true } } } }, secrets: { type: "object", patternProperties: { "^key": { type: "string", "x-weaver": { sensitive: true } } } } } };
  const target = structuredClone(source);
  target.default = {};
  target.properties.added = { type: "string", default: "x" };
  const result = buildUpgradePlan(input(source, target, { svc: { nested: { token: "TOPSECRET" }, secrets: { keyOne: "OTHERSECRET" } } }));
  assert.equal(result.status, "blocked");
  assert.equal(result.refusals[0].code, "unverifiable-secret");
  assert.equal(canonicalInternalJson(result).includes("SECRET"), false);
});

test("target sensitivity and unverifiable raw siblings block without disclosure", () => {
  const source = { type: "object", properties: { password: { type: "string" } } };
  const target = { type: "object", properties: { password: { type: "string", "x-weaver": { sensitive: true } }, added: { type: "string", default: "x" } } };
  for (const entries of [
    { svc: { password: "TARGETSECRET" } },
    { svc: { unknown: "UNVERIFIABLE", password: "ordinary" } },
  ]) {
    const result = buildUpgradePlan(input(source, target, entries));
    assert.equal(result.status, "blocked");
    assert.equal(result.refusals[0].code, "unverifiable-secret");
    assert.equal(canonicalInternalJson(result).includes("SECRET"), false);
    assert.equal(canonicalInternalJson(result).includes("UNVERIFIABLE"), false);
  }
});

test("raw secret markers refuse without serializing marker values", () => {
  const source = { type: "object", properties: { token: { type: "string" } } };
  const target = { type: "object", default: {}, properties: { token: { type: "string" }, added: { type: "string", default: "x" } } };
  const result = buildUpgradePlan(input(source, target, { svc: { token: { _weaver: "secret-ref", provider: "vault", uri: "TOPSECRET" } } }));
  assert.equal(result.status, "blocked");
  assert.equal(result.refusals[0].code, "unverifiable-secret");
  assert.equal(canonicalInternalJson(result).includes("TOPSECRET"), false);
});

test("missing, invalid, open, sensitive and marker defaults block", () => {
  const source = { type: "object" };
  const cases = [
    [{ type: "string" }, "missing-default"],
    [{ type: "integer", default: "bad" }, "invalid-default"],
    [{ type: "object", additionalProperties: { type: "string" }, default: {} }, "unsupported-governance"],
    [{ type: "string", default: "secret", "x-weaver": { sensitive: true } }, "unverifiable-secret"],
  ];
  for (const [property, code] of cases) {
    const result = buildUpgradePlan(input(source, { type: "object", properties: { added: property } }));
    assert.equal(result.status, "blocked");
    assert.equal(result.refusals[0].code, code);
  }
});

test("source open to explicit governance uses the explicit target own default", () => {
  const source = { type: "object", additionalProperties: { type: "string" } };
  const target = { type: "object", default: { named: "x" }, properties: { named: { type: "string", default: "x" } }, additionalProperties: false };
  const result = buildUpgradePlan(input(source, target));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.plan.steps[0].mutation.value, { named: "x" });
});

test("existing falsy, null, empty containers and arrays are never overwritten", () => {
  const source = { type: "object" };
  const target = { type: "object", default: {}, properties: { added: { type: ["string", "null"], default: "new" } } };
  for (const existing of [null, false, 0, "", [], {}]) {
    const result = buildUpgradePlan(input(source, target, { svc: { added: existing } }));
    assert.equal(result.status, existing === null || existing === "" ? "ready" : "blocked");
    if (result.status === "ready") assert.equal(result.plan.steps.length, 0);
  }
});

test("readonly, volatile, stale bindings and removals refuse", () => {
  const source = { type: "object" };
  const target = { type: "object", default: {}, properties: { added: { type: "string", default: "x" } } };
  const readonly = input(source, target); readonly.providers[0].writable = false;
  assert.equal(buildUpgradePlan(readonly).refusals[0].code, "ambiguous-placement");
  const volatile = input(source, target); volatile.providers[0].capabilities = { kind: "volatile-exclusive", durability: "memory", namespace: "memory:x", maxEnvelopeBytes: 100, scopedIO: "complete" };
  volatile.providers[0].namespace = "memory:x";
  assert.equal(buildUpgradePlan(volatile).refusals[0].code, "ambiguous-placement");
  const stale = input(source, target); stale.request.inventoryRevision = "9";
  assert.equal(buildUpgradePlan(stale).refusals[0].code, "stale-binding");
  const removed = input(target, source);
  assert.equal(buildUpgradePlan(removed).refusals[0].code, "explicit-disposition-required");
});

test("mixed ineligible providers are excluded when a durable target exists", () => {
  const source = { type: "object" };
  const target = { type: "object", default: {}, properties: { added: { type: "string", default: "x" } } };
  const value = input(source, target);
  value.infrastructure.layout.layers.push({ name: "cache", type: "ephemeral", providerId: "cache", config: { mergeId: "deep" } });
  value.infrastructure.providers.push({ id: "cache", factory: "memory", options: { durability: "volatile" } });
  value.providers.push({ providerId: "cache", namespace: "memory:cache", writable: true, capabilities: { kind: "volatile-exclusive", durability: "memory", namespace: "memory:cache", maxEnvelopeBytes: 100, scopedIO: "complete" }, layers: [{ revision: { ...revision, storeId: "memory:cache", layer: "cache" }, entries: {} }] });
  const result = buildUpgradePlan(value);
  assert.equal(result.status, "ready");
  assert.equal(result.plan.steps[0].target.providerId, "disk");
});

test("equivalent provider and schema ordering produces byte-identical plans", () => {
  const source = { type: "object", properties: { keep: { type: "boolean" } } };
  const target = { type: "object", default: {}, properties: { keep: { type: "boolean" }, added: { type: "string", default: "x" } } };
  const first = input(source, target, { svc: { keep: false } });
  first.infrastructure.layout.layers.push({ name: "audit", type: "static", providerId: "audit", config: { mergeId: "deep" } });
  first.infrastructure.providers.push({ id: "audit", factory: "fs", options: { filePath: "/tmp/audit.json" } });
  first.providers.push({ providerId: "audit", namespace: "fs:/tmp/audit.json", writable: false, capabilities: { kind: "durable-exclusive", durability: "local-fsync", namespace: "fs:/tmp/audit.json", maxEnvelopeBytes: 100, scopedIO: "complete" }, layers: [{ revision: { ...revision, storeId: "fs:audit", layer: "audit" }, entries: {} }] });
  const reordered = structuredClone(first);
  reordered.providers.reverse();
  reordered.schemas.reverse();
  reordered.sourceCatalog.registrations = Object.fromEntries(Object.entries(reordered.sourceCatalog.registrations).reverse());
  reordered.targetCatalog.registrations = Object.fromEntries(Object.entries(reordered.targetCatalog.registrations).reverse());
  reordered.schemas[0].source.properties = { keep: { type: "boolean" } };
  reordered.schemas[0].target.properties = { added: { type: "string", default: "x" }, keep: { type: "boolean" } };
  assert.equal(canonicalInternalJson(buildUpgradePlan(first)), canonicalInternalJson(buildUpgradePlan(reordered)));
});

test("contradictory duplicate physical revisions refuse", () => {
  const source = { type: "object" };
  const target = { type: "object", default: {}, properties: { added: { type: "string", default: "x" } } };
  const value = input(source, target);
  value.providers[0].layers.push({ revision: { ...revision, sequence: "2" }, entries: {} });
  const result = buildUpgradePlan(value);
  assert.equal(result.status, "blocked");
  assert.equal(result.refusals[0].code, "stale-binding");
});

test("dynamic per-leaf targets refuse when no shared durable layer exists", () => {
  const source = { type: "object" };
  const target = { type: "object", default: {}, properties: { added: { type: "string", default: "x" } } };
  const value = input(source, target);
  const path = [{ scopeId: "tenant", value: "one" }];
  value.inventory = { version: 1, revision: "1", contexts: { [encodeInternalIdentity([["tenant", "one"]])]: { scopePath: path, state: "active" } } };
  value.request.inventoryRevision = "1";
  value.infrastructure.layout.scopes = [{ id: "tenant", label: "Tenant" }];
  value.infrastructure.layout.layers[0] = { name: "tenant", type: "dynamic", providerId: "disk", config: { mergeId: "deep", scopeIds: ["tenant"] } };
  value.providers[0].layers = [{ revision: { ...revision, layer: "tenant:one" }, entries: {} }];
  const result = buildUpgradePlan(value);
  assert.equal(result.status, "blocked");
  assert.equal(result.refusals[0].code, "ambiguous-placement");
});

test("cold and retired contexts require shared placement and never produce tenant stamps", () => {
  const source = { type: "object" };
  const target = { type: "object", default: {}, properties: { added: { type: "string", default: "x" } } };
  const value = input(source, target);
  const a = [{ scopeId: "tenant", value: "a" }];
  const b = [{ scopeId: "tenant", value: "b" }];
  value.inventory = { version: 1, revision: "2", contexts: {
    [encodeInternalIdentity([["tenant", "a"]])]: { scopePath: a, state: "active" },
    [encodeInternalIdentity([["tenant", "b"]])]: { scopePath: b, state: "retired" },
  } };
  value.request.inventoryRevision = "2";
  value.infrastructure.layout.scopes = [{ id: "tenant", label: "Tenant" }];
  const result = buildUpgradePlan(value);
  assert.equal(result.status, "ready");
  assert.equal(result.plan.steps.length, 1);
  assert.equal(result.plan.steps[0].target.layer, "base");
  assert.equal(result.plan.contexts.length, 3);
});
