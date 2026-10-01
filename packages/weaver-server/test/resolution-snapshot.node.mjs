import assert from "node:assert/strict";
import { test } from "node:test";
import { deepMerge } from "@weaver-conf/config-engine";
import { inspectPublicConfig, publicConfigView } from "../src/core/public-config-inspection.ts";
import { createConfigStateReader } from "../src/core/config-service-state.ts";

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

test("missing paths, own mount discrimination and sparse-array projection ignore inherited traps", () => {
  let getters = 0, setters = 0;
  const keys = ["inspectionInheritedTrap", "_weaver", "source", "700"];
  for (const key of keys) Object.defineProperty(Object.prototype, key, { configurable: true, get() { getters++; return "_weaver.registry.secret"; }, set() { setters++; } });
  try {
    const sparse = []; sparse.length = 701;
    const entries = { cfg: { value: 1 }, sparse, missingSource: { _weaver: "mount" }, safe: { _weaver: "mount", source: "cfg.value" }, secretAlias: { _weaver: "mount", source: "_weaver.registry.secret" } };
    const layers = [{ layer: "core", entries }];
    assert.equal(inspectPublicConfig("inspectionInheritedTrap", layers).effectiveValue, undefined);
    assert.deepEqual(inspectPublicConfig("inspectionInheritedTrap", layers).layerValues, {});
    assert.equal(inspectPublicConfig("sparse.700", layers).effectiveValue, undefined);
    assert.deepEqual(inspectPublicConfig("cfg", layers).effectiveValue, { value: 1 });
    assert.deepEqual(inspectPublicConfig("missingSource", layers).effectiveValue, { _weaver: "mount" });
    assert.equal(inspectPublicConfig("safe", layers).effectiveValue.source, "cfg.value");
    assert.equal(inspectPublicConfig("secretAlias", layers).effectiveValue, undefined);
    const projected = publicConfigView.entries(entries);
    assert.equal(Object.hasOwn(projected.sparse, "700"), false);
    assert.equal(getters, 0);
    assert.equal(setters, 0);
  } finally {
    for (const key of keys) delete Object.prototype[key];
  }
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

test("deep projection worklists do not invoke inherited numeric setters", () => {
  let value = { leaf: 1 }, getters = 0, setters = 0, projected;
  for (let index = 0; index < 10000; index++) value = { next: value };
  Object.defineProperty(Object.prototype, "700", { configurable: true, get() { getters++; }, set() { setters++; } });
  try { projected = publicConfigView.entries({ cfg: value }); }
  finally { delete Object.prototype["700"]; }
  let leaf = projected.cfg;
  for (let index = 0; index < 10000; index++) leaf = leaf.next;
  assert.equal(leaf.leaf, 1);
  assert.equal(getters, 0);
  assert.equal(setters, 0);
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

function underNumericMountTrap(operation) {
  let getters = 0, setters = 0, result;
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "700");
  Object.defineProperty(Object.prototype, "700", {
    configurable: true,
    get() { getters++; return "ambient"; },
    set() { setters++; },
  });
  try { result = operation(); }
  finally {
    if (descriptor) Object.defineProperty(Object.prototype, "700", descriptor);
    else delete Object.prototype["700"];
  }
  assert.equal(getters, 0);
  assert.equal(setters, 0);
  return result;
}

function assertMountViews(entries, omitted) {
  const projected = underNumericMountTrap(() => publicConfigView.entries(entries));
  const inspected = underNumericMountTrap(() => inspectPublicConfig("node0", [{ layer: "core", entries }]));
  const delta = underNumericMountTrap(() => publicConfigView.delta({
    action: "set", key: "alias", value: { _weaver: "mount", source: "node0" },
    layer: "core", environment: "test", timestamp: "2026-10-01T00:00:00Z",
  }, entries));
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
    test(`${size} ${kind} own-data mount chain preserves redaction and memoization with numeric traps`, () => {
      const entries = mountChain(size, terminal);
      if (kind === "protected cycle") Object.defineProperty(entries, "_weaver", { value: { loop: { _weaver: "mount", source: "node0" } }, enumerable: true });
      assertMountViews(entries, omitted);
    });
  }
}
