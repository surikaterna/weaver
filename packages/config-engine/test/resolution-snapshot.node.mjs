import assert from "node:assert/strict";
import { test } from "node:test";
import { deepMerge, inspectKey, resolveConfiguration, resolveConfigurationSnapshot, inspectResolvedPath } from "../dist/index.js";
import { resolveConfigurationWithCeiling } from "../dist/layers.js";
import * as engine from "../dist/index.js";

const layer = (entries, rank = 0, extra = {}) => ({ layer: ["core", "user", "session"][rank], providerId: `p${rank}`, rank, entries, ...extra });
const resolve = (layers, ceilings = []) => resolveConfigurationSnapshot({ layers, ceilings, configuredRanks: [0, 1, 2] });
const inspect = (snapshot, ...path) => inspectResolvedPath(snapshot, path);
const code = (expected) => (error) => error.code === expected;

test("nested winners derive from operations, not equality or highest object writer", () => {
  const snapshot = resolve([layer({ cfg: { a: 1, b: 2 } }), layer({ cfg: { a: 1, c: 3 } }, 1)]);
  assert.deepEqual(snapshot.entries, { cfg: { a: 1, b: 2, c: 3 } });
  assert.equal(inspect(snapshot, "cfg").effectiveLayer, undefined);
  assert.equal(inspect(snapshot, "cfg", "a").effectiveLayer, "user");
  assert.equal(inspect(snapshot, "cfg", "b").effectiveLayer, "core");
  assert.deepEqual(inspect(snapshot, "cfg").contributions.map(({ value }) => value), [{ a: 1, b: 2 }, { a: 1, c: 3 }]);
  const providers = resolve([layer({ cfg: { a: 1 } }), layer({ cfg: { b: 2 } }, 0, { providerId: "other" })]);
  assert.equal(inspect(providers, "cfg").effectiveLayer, undefined);
  assert.equal(inspect(providers, "cfg", "b").effectiveProviderId, "other");
});

test("reserved own data survives merging and every data schema without becoming path authority", () => {
  const first = JSON.parse('{"__proto__":{"low":1},"constructor":{"prototype":{"low":1}},"prototype":1,"cfg":{"__proto__":{"low":1},"constructor":{"prototype":1},"prototype":1,"retained":2}}');
  const second = JSON.parse('{"__proto__":{"high":2},"constructor":{"prototype":{"high":2}},"prototype":2,"cfg":{"__proto__":{"high":2},"prototype":2}}');
  const before = JSON.stringify([first, second]);
  const input = { configuredRanks: [0, 1], ceilings: [], layers: [layer(first, 0, { layer: "__proto__", providerId: "constructor" }), layer(second, 1, { layer: "prototype", providerId: "__proto__" })] };
  const snapshot = resolveConfigurationSnapshot(input);
  const merged = deepMerge(first, second);
  assert.deepEqual(snapshot.entries, merged);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(merged, "__proto__"), { value: { low: 1, high: 2 }, writable: true, configurable: true, enumerable: true });
  assert.equal(Object.hasOwn(Object.prototype, "high"), false);
  assert.equal(Object.hasOwn(Object.prototype, "low"), false);
  assert.equal(JSON.stringify([first, second]), before);
  assert.equal(Object.isFrozen(first), false);
  const parent = inspect(snapshot, "cfg");
  assert.equal(parent.effectiveValue, snapshot.entries.cfg, "issued inspection shares one immutable generation");
  assert.equal(parent.effectiveLayer, undefined);
  assert.equal(Object.hasOwn(parent.effectiveValue, "__proto__"), true);
  assert.notEqual(parent.contributions[0].value, first.cfg);
  assert.throws(() => { parent.contributions[0].value.prototype = 9; }, TypeError);
  assert.deepEqual(Object.keys(snapshot).sort(), ["entries", "layers"]);
  const parsedInput = engine.resolutionSnapshotInputSchema.parse(input);
  const parsedLayer = engine.resolutionLayerSchema.parse(input.layers[0]);
  const parsedSnapshot = engine.configurationSnapshotSchema.parse(snapshot);
  const parsedContribution = engine.resolutionContributionSchema.parse(parent.contributions[0]);
  const parsedInspection = engine.resolvedPathInspectionSchema.parse(parent);
  for (const record of [parsedInput.layers[0].entries, parsedLayer.entries, parsedSnapshot.entries, parsedContribution.value, parsedInspection.effectiveValue]) {
    assert.equal(Object.hasOwn(record, "__proto__"), true);
    assert.equal(Object.hasOwn(record, "constructor"), true);
    assert.equal(Object.hasOwn(record, "prototype"), true);
  }
  assert.deepEqual(engine.resolutionOriginSchema.parse(parent.contributions[0].origin), parent.contributions[0].origin);
  assert.deepEqual(engine.resolutionPathSchema.parse(["cfg", "__proto__"]), ["cfg", "__proto__"]);
  assert.deepEqual(engine.resolvedPathInspectionSchema.parse({ ...parent, path: ["__proto__"] }).path, ["__proto__"]);
  const roundtrip = JSON.parse(JSON.stringify(parsedSnapshot));
  assert.deepEqual(engine.configurationSnapshotSchema.parse(roundtrip).entries, snapshot.entries);
  for (const segment of ["__proto__", "constructor", "prototype"]) {
    assert.throws(() => inspect(snapshot, "cfg", segment), code("VALIDATION_ERROR"));
    assert.throws(() => resolve([layer(first)], [{ path: ["cfg", segment], maxRank: 0 }]), code("VALIDATION_ERROR"));
    assert.equal(engine.resolutionCeilingSchema.safeParse({ path: [segment], maxRank: 0 }).success, false);
  }
  assert.equal(inspect(snapshot).effectiveValue, snapshot.entries);
});

test("inherited traps are never read or assigned, including absent contributions and sparse arrays", () => {
  let getters = 0, setters = 0;
  const trap = "snapshotInheritedTrap";
  for (const key of [trap, "700"]) Object.defineProperty(Object.prototype, key, { configurable: true, get() { getters++; return "inherited"; }, set() { setters++; } });
  try {
    const own = {}; Object.defineProperty(own, trap, { value: 3, enumerable: true });
    const sparse = []; sparse.length = 701;
    const snapshot = resolve([layer({ own, sparse }), layer({ own: { kept: 1 } }, 1)]);
    assert.equal(inspect(snapshot, "own", trap).effectiveValue, 3);
    assert.equal(inspect(snapshot, trap).present, false);
    assert.equal(inspect(snapshot, trap).contributions.every(({ present }) => !present), true);
    assert.equal(inspect(snapshot, "sparse", "700").present, false);
    assert.equal(Object.hasOwn(snapshot.entries.sparse, "700"), false);
    const sparsePath = []; sparsePath.length = 701;
    assert.throws(() => inspectResolvedPath(snapshot, sparsePath), code("VALIDATION_ERROR"));
    assert.throws(() => inspectResolvedPath({ ...snapshot, trace: sparsePath }, ["own"]), code("VALIDATION_ERROR"));
    assert.equal(getters, 0);
    assert.equal(setters, 0);
  } finally {
    for (const key of [trap, "700"]) delete Object.prototype[key];
  }
});

test("forged snapshots and public schemas preflight hidden accessors, symbols and reflection failures", () => {
  let calls = 0;
  const snapshot = resolve([layer({ cfg: 1 })]);
  for (const root of [snapshot, { ...snapshot, entries: { cfg: {} } }]) {
    const forged = { ...root };
    Object.defineProperty(forged, "hidden", { get() { calls++; return 1; } });
    assert.throws(() => inspect(forged, "cfg"), code("VALIDATION_ERROR"));
    assert.throws(() => engine.configurationSnapshotSchema.parse(forged), code("VALIDATION_ERROR"));
  }
  const getter = {}; Object.defineProperty(getter, "__proto__", { enumerable: true, get() { calls++; return {}; } });
  const setter = {}; Object.defineProperty(setter, "constructor", { set() { calls++; } });
  for (const entries of [getter, setter, { child: getter }, { child: Symbol("value") }]) assert.throws(() => resolve([layer(entries)]), code("VALIDATION_ERROR"));
  const forgedEntries = { ...snapshot, entries: { get cfg() { calls++; return 1; } } };
  assert.throws(() => inspect(forgedEntries, "cfg"), code("VALIDATION_ERROR"));
  assert.equal(calls, 0);
  assert.throws(() => resolve([layer(new Proxy({}, { ownKeys() { throw new Error("reflection"); } }))]), code("VALIDATION_ERROR"));
});

test("default semantics match legacy including inserted undefined and atomic resets", () => {
  const values = [{ cfg: { a: undefined, b: 2 }, array: [1, 2] }, { cfg: { b: undefined }, array: [] }, { cfg: null }, { cfg: { c: 3 } }];
  for (let count = 1; count <= values.length; count++) {
    const layers = values.slice(0, count).map((entries, i) => layer(entries, i % 3, { providerId: `p${i}` }));
    const snapshot = resolve(layers);
    assert.deepEqual(snapshot.entries, values.slice(0, count).reduce(deepMerge, {}));
    assert.equal(inspect(snapshot, "array").effectiveLayer, count > 1 ? "user" : "core");
    assert.equal(inspect(snapshot, "array", "9").present, false);
  }
  assert.equal(inspect(resolve([layer(values[0])]), "cfg", "a").present, true);
  assert.equal(inspect(resolve([layer({ x: undefined })]), "x").present, false);
  assert.equal(inspect(resolve([layer({ x: undefined })])).effectiveLayer, undefined);
  assert.equal(inspect(resolve([layer({ cfg: {} }), layer({ cfg: { a: 1 } }, 1)]), "cfg").effectiveLayer, "user");
  assert.equal(inspect(resolve([layer({ cfg: {} })]), "cfg").effectiveLayer, "core");
  assert.equal(inspect(resolve([layer({ cfg: {} }), layer({ cfg: {} }, 1)]), "cfg").effectiveLayer, "user");
  assert.equal(inspect(resolve([layer({ cfg: { a: 1 } }), layer({ cfg: null }, 1)]), "cfg", "a").effectiveLayer, undefined);
});

test("ceilings tighten by ancestry, preserve siblings, block destructive missing-child erasure", () => {
  const ceilings = [{ path: ["cfg"], maxRank: 1 }, { path: ["cfg", "locked"], maxRank: 0 }];
  const snapshot = resolve([layer({ cfg: { locked: 1, open: 1 } }), layer({ cfg: { locked: 1, open: 2 } }, 1), layer({ cfg: { open: 3 } }, 2)], ceilings);
  assert.deepEqual(snapshot.entries.cfg, { locked: 1, open: 2 });
  assert.equal(inspect(snapshot, "cfg", "locked").effectiveLayer, "core");
  assert.equal(inspect(snapshot, "cfg", "locked").contributions.length, 3);
  for (const replacement of [null, 7, [1]]) {
    assert.deepEqual(resolve([layer({ cfg: { open: 1 } }), layer({ cfg: replacement }, 1)], ceilings).entries.cfg, { open: 1 });
    assert.equal(inspect(resolve([layer({ cfg: replacement }, 1)], ceilings), "cfg").present, false);
  }
  assert.deepEqual(resolve([layer({ cfg: { locked: 1 } }, 1)], ceilings).entries, { cfg: {} });
  assert.equal(inspect(resolve([layer({ cfg: {} }), layer({ cfg: { locked: 9 } }, 1)], ceilings), "cfg").effectiveLayer, "core");
  const noLoosen = [{ path: ["cfg"], maxRank: 0 }, { path: ["cfg", "open"], maxRank: 2 }];
  assert.deepEqual(resolve([layer({ cfg: { open: 3 } }, 2)], noLoosen).entries, {});
  const arrayCeiling = [{ path: ["items", "0", "x"], maxRank: 0 }];
  assert.deepEqual(resolve([layer({ items: [] }), layer({ items: [{ x: 2 }] }, 1)], arrayCeiling).entries.items, []);
  assert.deepEqual(resolve([layer({ items: [{ x: 1 }] }), layer({ items: {} }, 1)], arrayCeiling).entries.items, [{ x: 1 }]);
});

test("trusted eligibility is explicit and never inferred from session naming", () => {
  const ceilings = [{ path: ["x"], maxRank: 0 }];
  assert.equal(resolve([layer({ x: 1 }), layer({ x: 2 }, 2)], ceilings).entries.x, 1);
  assert.equal(resolve([layer({ x: 1 }), layer({ x: 2 }, 2, { trustedEmergency: true })], ceilings).entries.x, 2);
  assert.equal(resolve([layer({ x: 1 }), layer({ x: 2 }, 2, { trustedEmergency: true }), layer({ x: 3 }, 1)], ceilings).entries.x, 2);
});

test("ranks are finite configured positions, stack order wins and unknown ranks fail typed", () => {
  const snapshot = resolveConfigurationSnapshot({ configuredRanks: [10, 20], ceilings: [{ path: ["x"], maxRank: 20 }], layers: [layer({ x: 1 }, 0, { rank: 20 }), layer({ x: 2 }, 1, { rank: 10 })] });
  assert.equal(snapshot.entries.x, 2);
  for (const rank of [99, NaN, Infinity]) assert.throws(() => resolve([layer({ x: 1 }, 0, { rank })]), code("VALIDATION_ERROR"));
  assert.throws(() => resolve([], [{ path: ["x"], maxRank: 99 }]), code("VALIDATION_ERROR"));
  assert.throws(() => resolve([layer({}), layer({})]), code("VALIDATION_ERROR"));
});

test("descriptor-first snapshots reject hazards without executing getters or callbacks", () => {
  let calls = 0;
  const bad = { good: { a: 1 }, get bad() { calls++; return 2; } };
  assert.throws(() => resolve([layer(bad)]), code("VALIDATION_ERROR"));
  assert.equal(calls, 0);
  let deepHazard = bad;
  for (let depth = 0; depth < 5000; depth++) deepHazard = { next: deepHazard };
  assert.throws(() => resolve([layer(deepHazard)]), code("VALIDATION_ERROR"));
  assert.equal(calls, 0, "descriptor validation is iterative even for deeply nested hazards");
  const cyclic = {}; cyclic.self = cyclic;
  const prototype = Object.create({ evil: 1 });
  const symbol = { [Symbol("secret")]: 1 };
  const customArray = []; Object.setPrototypeOf(customArray, Object.create(Array.prototype));
  for (const entries of [cyclic, prototype, symbol, { nested: new Date() }, { nested: customArray }]) {
    assert.throws(() => resolve([layer(entries)]), code("VALIDATION_ERROR"));
  }
  assert.throws(() => resolve([layer({ x: 1 }, 0, { merge: () => { calls++; } })]), code("UNSUPPORTED_OPERATION"));
  assert.equal(calls, 0);
});

test("acyclic sharing is detached, null prototypes accepted, all outputs frozen", () => {
  const shared = Object.assign(Object.create(null), { x: 1 });
  const input = { "literal.dot": { "日本語": shared }, other: shared };
  const snapshot = resolve([layer(input)]);
  shared.x = 9;
  const inspection = inspect(snapshot, "literal.dot", "日本語", "x");
  assert.equal(inspection.effectiveValue, 1);
  assert.notEqual(snapshot.entries.other, shared);
  assert.equal(snapshot.entries.other, snapshot.entries["literal.dot"]["日本語"], "immutable acyclic aliases are preserved");
  assert.throws(() => { snapshot.entries.other.x = 7; }, TypeError);
  assert.throws(() => { inspection.contributions[0].origin.layer = "evil"; }, TypeError);
  assert.equal(inspect(snapshot, "literal", "dot").present, false);
  assert.equal(inspect(snapshot, "missing").effectiveLayer, undefined);
});

test("legacy callbacks retain exact argument identity, execution order/count and flat inspection", () => {
  const first = { n: 1 }, second = { n: 2 };
  const events = [];
  const callback = (base, override) => { events.push([base, override]); return { n: (base.n ?? 0) + override.n }; };
  const stack = { layers: [{ layer: "core", entries: first, merge: callback }, { layer: "user", entries: {}, merge: callback }, { layer: "session", entries: second, merge: callback }] };
  const resolved = resolveConfiguration(stack);
  const inserted = { own: undefined };
  assert.equal(deepMerge({}, { inserted }).inserted, inserted, "legacy first insertion retains identity");
  assert.equal(resolved.entries.n, 3);
  assert.equal(events.length, 2);
  assert.equal(events[0][1], first);
  assert.equal(events[1][1], second);
  assert.equal(events[1][0].n, 1);
  assert.equal(resolved.provenance.get("n"), "session");
  assert.equal(inspectKey({ layers: [{ layer: "core", entries: { cfg: { a: 1 } } }] }, "cfg.a").effectiveValue, undefined);
  events.length = 0;
  assert.equal(resolveConfigurationWithCeiling(stack, new Map(), false, () => 0).entries.n, 3);
  assert.equal(events.length, 2, "private helper retains original custom callbacks");
  assert.deepEqual(events.map(([, override]) => override), [first, second]);
  events.length = 0;
  assert.equal(resolveConfigurationWithCeiling(stack, new Map(), true, () => 0).entries.n, 3);
  assert.equal(events.length, 2);
  assert.equal(events[0][1], first);
  assert.equal(events[1][1], second);
  events.length = 0;
  const ceilings = new Map([["n", { "x-weaver": { maxOverrideLayer: "core" } }]]);
  assert.equal(resolveConfigurationWithCeiling(stack, ceilings, false, (name) => name === "core" ? 0 : 1).entries.n, 1);
  assert.equal(events.length, 1, "filtered empty entries do not execute a callback");
});
