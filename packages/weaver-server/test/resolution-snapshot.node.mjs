import assert from "node:assert/strict";
import { test } from "node:test";
import { deepMerge } from "@weaver-conf/config-engine";
import { inspectPublicConfig, publicConfigView } from "../src/core/public-config-inspection.ts";
import { createConfigStateReader } from "../src/core/config-service-state.ts";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { createConfigAdmission } from "../src/core/config-service-admission-context.ts";
import { resolveOrderedEntries } from "../src/core/ordered-config-resolution.ts";

test("server inspection returns merged values and operation origins without changing raw breakdown", () => {
  const layers = [
    { layer: "core", entries: { cfg: { a: 1, b: 2 }, array: [1] } },
    { layer: "user", entries: { cfg: { a: 1, c: 3 }, array: [] } },
  ];
  const object = inspectPublicConfig("cfg", layers);
  assert.deepEqual(object.effectiveValue, { a: 1, b: 2, c: 3 });
  assert.equal(object.effectiveLayer, undefined);
  assert.deepEqual(object.layerValues, { core: { a: 1, b: 2 }, user: { a: 1, c: 3 } });
  assert.equal(inspectPublicConfig("cfg.a", layers).effectiveLayer, "user");
  assert.equal(inspectPublicConfig("cfg.b", layers).effectiveLayer, "core");
  assert.equal(inspectPublicConfig("array", layers).effectiveLayer, "user");
});

test("inspection and projection retain inert reserved own children with ordinary output descriptors", () => {
  const low = JSON.parse('{"cfg":{"__proto__":{"a":1},"constructor":{"prototype":{"a":1}},"prototype":1,"retained":2}}');
  const high = JSON.parse('{"cfg":{"__proto__":{"b":2},"constructor":{"prototype":{"b":2}},"prototype":2}}');
  const layers = [{ layer: "__proto__", entries: low }, { layer: "constructor", entries: high }];
  const inspection = inspectPublicConfig("cfg", layers);
  assert.equal(inspection.effectiveLayer, undefined);
  assert.equal(Object.getPrototypeOf(inspection.layerValues), Object.prototype);
  assert.equal(Object.hasOwn(inspection.layerValues, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(inspection.effectiveValue), Object.prototype);
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const descriptor = Object.getOwnPropertyDescriptor(inspection.effectiveValue, key);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
    assert.throws(() => inspectPublicConfig(`cfg.${key}`, layers), error => error.code === "VALIDATION_ERROR");
  }
  assert.deepEqual(inspection.effectiveValue.__proto__, { a: 1, b: 2 });
  assert.equal(Object.hasOwn(Object.prototype, "a"), false);
});

test("missing paths, own mount discrimination and sparse-array projection stay distinct", () => {
    const sparse = []; sparse.length = 701;
    const entries = { cfg: { value: 1 }, sparse, missingSource: { _weaver: "mount" }, safe: { _weaver: "mount", source: "cfg.value" }, secretAlias: { _weaver: "mount", source: "_weaver.registry.secret" } };
    const layers = [{ layer: "core", entries }];
    assert.equal(inspectPublicConfig("absent", layers).effectiveValue, undefined);
    assert.deepEqual(inspectPublicConfig("absent", layers).layerValues, {});
    assert.equal(inspectPublicConfig("sparse.700", layers).effectiveValue, undefined);
    assert.deepEqual(inspectPublicConfig("cfg", layers).effectiveValue, { value: 1 });
    assert.deepEqual(inspectPublicConfig("missingSource", layers).effectiveValue, { _weaver: "mount" });
    assert.equal(inspectPublicConfig("safe", layers).effectiveValue.source, "cfg.value");
    assert.equal(inspectPublicConfig("secretAlias", layers).effectiveValue, undefined);
    const projected = publicConfigView.entries(entries);
    assert.equal(Object.hasOwn(projected.sparse, "700"), false);
});

test("server inspection rejects nested/hidden accessors without executing raw layer reads", () => {
  let calls = 0;
  const entries = { cfg: {} };
  Object.defineProperty(entries.cfg, "hidden", { get() { calls++; return 1; } });
  assert.throws(() => inspectPublicConfig("cfg", [{ layer: "core", entries }]), error => error.code === "VALIDATION_ERROR");
  const forged = { layer: "core", get entries() { calls++; return {}; } };
  assert.throws(() => inspectPublicConfig("cfg", [forged]), error => error.code === "VALIDATION_ERROR");
  assert.equal(calls, 0);
});

test("server projection and inspection handle deep records and shared value graphs iteratively", () => {
  for (const depth of [3000, 10000]) {
    let value = { leaf: 1 };
    for (let index = 0; index < depth; index++) value = { next: value };
    const inspection = inspectPublicConfig("cfg", [{ layer: "core", entries: { cfg: value } }]);
    assert.equal(inspection.effectiveLayer, "core");
    let leaf = inspection.effectiveValue;
    for (let index = 0; index < depth; index++) leaf = leaf.next;
    assert.equal(leaf.leaf, 1);
  }
  let value = { leaf: 1 };
  for (let index = 0; index < 30; index++) value = { left: value, right: value };
  const projected = publicConfigView.entries({ cfg: value });
  assert.equal(projected.cfg.left, projected.cfg.right);
  assert.notEqual(projected.cfg, value);
});

test("deep projection preserves the terminal leaf", () => {
  let value = { leaf: 1 };
  for (let index = 0; index < 10000; index++) value = { next: value };
  const projected = publicConfigView.entries({ cfg: value });
  let leaf = projected.cfg;
  for (let index = 0; index < 10000; index++) leaf = leaf.next;
  assert.equal(leaf.leaf, 1);
});

test("state adapter retains fixed-before-scope ordering and independently merged scope grouping", () => {
  const providers = [{ id: "base", layer: "user" }, { id: "scope1", layer: "tenant:t" }, { id: "scope2", layer: "site:s" }];
  const data = new Map([
    ["base", { cfg: { a: 1, b: 2 } }],
    ["scope1", { cfg: null }],
    ["scope2", { cfg: { a: undefined, c: 3 } }],
  ]);
  const reader = createConfigStateReader(providers, data, new Map());
  const path = [{ scopeId: "tenant", value: "t" }, { scopeId: "site", value: "s" }];
  const scopes = deepMerge(data.get("scope1"), data.get("scope2"));
  assert.deepEqual(reader.getMergedState(path), deepMerge(data.get("base"), scopes));
  assert.deepEqual(reader.getMergedState(path), { cfg: { a: 1, b: 2, c: 3 } });
});

test("protected config and tainted mount inspection remain omitted", () => {
  const layers = [{ layer: "core", entries: { _weaver: { registry: { secret: "hidden" } }, alias: { _weaver: "mount", source: "_weaver.registry.secret" } } }];
  assert.equal(inspectPublicConfig("_weaver.registry.secret", layers).effectiveValue, undefined);
  assert.equal(inspectPublicConfig("alias", layers).effectiveValue, undefined);
});

function mountChain(size, terminal) {
  const entries = { terminal: { public: true }, nested: { alias: { _weaver: "mount", source: "node0" } } };
  for (let index = 0; index < size; index++) {
    Object.defineProperty(entries, `node${index}`, {
      value: { _weaver: "mount", source: index === size - 1 ? terminal : `node${index + 1}` },
      enumerable: true,
    });
  }
  return entries;
}

function assertMountViews(entries, omitted) {
  const projected = publicConfigView.entries(entries);
  const inspected = inspectPublicConfig("node0", [{ layer: "core", entries }]);
  const delta = publicConfigView.delta({
    action: "set", key: "alias", value: { _weaver: "mount", source: "node0" },
    layer: "core", environment: "test", timestamp: "2026-10-01T00:00:00Z",
   }, entries);
  assert.equal(Object.hasOwn(projected, "node0"), !omitted);
  assert.equal(Object.hasOwn(projected.nested, "alias"), !omitted);
  assert.equal(inspected.effectiveValue === undefined, omitted);
  assert.equal(delta.value === undefined, omitted);
  if (omitted) {
    assert.deepEqual(inspected.layerValues, {});
    assert.equal(inspected.effectiveLayer, undefined);
    for (const key of Object.keys(entries).filter(key => key.startsWith("node"))) assert.equal(Object.hasOwn(projected, key), false);
  } else {
    assert.equal(inspected.effectiveValue.source, "node1");
    assert.equal(inspected.effectiveLayer, "core");
    assert.equal(delta.value.source, "node0");
    assert.equal(Object.hasOwn(projected, "node700"), true);
  }
}

for (const size of [702, 20000]) {
  for (const [kind, terminal, omitted] of [
    ["public", "terminal", false],
    ["unregistered protected", "_weaver.unregistered.secret", true],
    ["public cycle", "node0", false],
    ["protected cycle", "_weaver.loop", true],
  ]) {
    test(`${size} ${kind} mount chain preserves redaction and memoization`, () => {
      const entries = mountChain(size, terminal);
      if (kind === "protected cycle") Object.defineProperty(entries, "_weaver", { value: { loop: { _weaver: "mount", source: "node0" } }, enumerable: true });
      assertMountViews(entries, omitted);
    });
  }
}

async function orderedProviderFixture(kind, size) {
  const providers = kind === "dynamic"
    ? [createInMemoryStorageProvider({ id: "dynamic", layer: "tenant" })]
    : Array.from({ length: size }, (_, index) => createInMemoryStorageProvider({
      id: `p${index}`, layer: kind === "scoped" ? `tenant:v${index}` : index === size - 1 ? "user" : "core",
      initialEntries: { cfg: { n: index, mirror: index } },
    }));
  const scopePath = Array.from({ length: size }, (_, index) => ({ scopeId: "tenant", value: `v${index}` }));
  const dynamic = new Map();
  if (kind === "dynamic") {
    for (let index = 0; index < size; index++) {
      const layer = `tenant:v${index}`;
      await providers[0].writeLayer(layer, "cfg", { n: index, mirror: index });
      dynamic.set(layer, (await providers[0].loadLayer(layer)).entries);
    }
  }
  const data = new Map();
  for (const provider of providers) data.set(provider.id, (await provider.load()).entries);
  const effects = observeProviderEffects(providers);
  const service = await createWeaverConfigService({ providers, environment: "test" });
  const registry = createSchemaRegistry({ configService: service });
  const registered = await registry.register({ serviceId: "cfg", environment: "test", owner: { name: "test", contact: "test@example.org" }, schema: orderedSchema(size - 1), fragmentSlots: [] });
  assert.equal(registered.success, true, registered.error?.message ?? JSON.stringify(registered));
  if (kind === "dynamic") await service.get("cfg.n", { scopePath });
  service.onDelta(() => { effects.delta++; });
  const target = providers[providers.length - 1];
  const layer = kind === "fixed" ? "user" : `tenant:v${size - 1}`;
  const preflight = createConfigAdmission({ service: () => service, environment: "test", providers, layerData: data, dynamicScopeEntries: dynamic,
    resolveProvider: () => target, getLayerValue: async () => undefined, warmScopeLayers: async () => {},
  });
  return { providers, data, dynamic, scopePath, service, effects, preflight, layer, kind };
}

function observeProviderEffects(providers) {
  const effects = { write: 0, remove: 0, flush: 0, delta: 0 };
  for (const provider of providers) {
    for (const name of ["write", "writeLayer", "remove", "removeLayer"]) {
      const original = provider[name].bind(provider);
      provider[name] = async (...args) => { effects[name.startsWith("write") ? "write" : "remove"]++; return original(...args); };
    }
    provider.flush = async () => { effects.flush++; };
  }
  return effects;
}

function orderedSchema(end) {
  return { type: "object", properties: { n: { type: "integer" }, mirror: { type: "integer" } }, required: ["n", "mirror"],
    anyOf: [{ type: "object", properties: { n: { type: "integer", const: end }, mirror: { type: "integer", const: end } } }, { type: "object", properties: { n: { type: "integer", const: 9001 }, mirror: { type: "integer", const: 9001 } } }],
  };
}

function directOrderedBaseline(fixture) {
  let result = {};
  if (fixture.kind === "fixed") {
    for (const provider of fixture.providers) result = deepMerge(result, fixture.data.get(provider.id));
  } else {
    for (const scope of fixture.scopePath) {
      const layer = `${scope.scopeId}:${scope.value}`;
      for (const provider of fixture.providers) if (provider.layer === layer) result = deepMerge(result, fixture.data.get(provider.id));
      const dynamic = fixture.dynamic.get(layer);
      if (dynamic) result = deepMerge(result, dynamic);
    }
  }
  return result;
}

async function assertOrderedAdmission(fixture) {
  const options = fixture.kind === "fixed" ? undefined : { scopePath: fixture.scopePath.slice(0, 700) };
  const revision = fixture.service.revision;
  const valid = [{ operation: "set", key: "cfg.n", value: 9001 }, { operation: "set", key: "cfg.mirror", value: 9001 }];
  const invalid = [{ operation: "set", key: "cfg.n", value: 9001 }, { operation: "remove", key: "cfg.mirror" }];
  assert.equal(await fixture.preflight(fixture.layer, valid, options), null);
  assert.equal((await fixture.preflight(fixture.layer, invalid, options)).error.code, "VALIDATION_ERROR");
  const batch = await fixture.service.setMany(fixture.layer, { "cfg.n": 9001, "cfg.mirror": 7 }, options);
  assert.equal(batch.success, false);
  assert.equal(batch.error.code, "VALIDATION_ERROR");
  assert.deepEqual(fixture.effects, { write: 0, remove: 0, flush: 0, delta: 0 });
  assert.equal(fixture.service.revision, revision);
}

for (const kind of ["fixed", "scoped", "dynamic"]) {
  test(`702 ${kind} ordered entries preserve baseline and provenance`, async () => {
    const fixture = await orderedProviderFixture(kind, 702);
    const baseline = directOrderedBaseline(fixture);
    const reader = createConfigStateReader(fixture.providers, fixture.data, fixture.dynamic);
    const actual = kind === "fixed" ? reader.getBaseEntries() : reader.getScopeState(fixture.scopePath);
    assert.deepEqual(actual, baseline);
    assert.equal(actual.cfg.n, 701);
    const merged = reader.getMergedState(kind === "fixed" ? undefined : fixture.scopePath);
    assert.deepEqual(merged, baseline);
    const inspected = await fixture.service.inspect("cfg.n");
    assert.equal(inspected.effectiveValue, 701);
    assert.equal(inspected.effectiveLayer, kind === "fixed" ? "user" : "tenant:v701");
  });
  test(`702 ${kind} prospective and actual batch admission preserve zero effects`, async () => {
    await assertOrderedAdmission(await orderedProviderFixture(kind, 702));
  });
}

test("fixed scoped-provider and dynamic-cache tails both use owned ordered slots", async () => {
  const providers = Array.from({ length: 700 }, (_, index) => createInMemoryStorageProvider({ id: `p${index}`, layer: "tenant:site", initialEntries: { cfg: { n: index } } }));
  const data = new Map();
  for (const provider of providers) data.set(provider.id, (await provider.load()).entries);
  const dynamic = new Map([["tenant:site", { cfg: { n: 9001 } }]]);
  const reader = createConfigStateReader(providers, data, dynamic);
  assert.equal(reader.getScopeState([{ scopeId: "tenant", value: "site" }]).cfg.n, 9001);
});

test("ordered adapter reads only own dense entries, not inherited slots or accessor rows", async () => {
  const sparse = Array.from({ length: 702 }, (_, index) => ({ cfg: { n: index } }));
  delete sparse["700"];
  assert.throws(() => resolveOrderedEntries(sparse), error => error.code === "VALIDATION_ERROR");
  let calls = 0;
  const accessor = [];
  Object.defineProperty(accessor, "0", { get() { calls++; return {}; } });
  assert.throws(() => resolveOrderedEntries(accessor), error => error.code === "VALIDATION_ERROR");
  assert.equal(calls, 0);
  const dense = Array.from({ length: 702 }, (_, index) => ({ cfg: { n: index } }));
  Object.defineProperty(dense[0], "700", { value: { inert: true }, enumerable: true });
  const result = resolveOrderedEntries(dense);
  assert.equal(result.cfg.n, 701);
  assert.equal(Object.hasOwn(result, "700"), true);
});
