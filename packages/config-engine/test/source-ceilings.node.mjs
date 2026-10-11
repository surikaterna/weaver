import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectResolvedPath,
  resolutionLayerSchema,
  resolutionSnapshotInputSchema,
  resolveConfigurationSnapshot,
} from "../dist/index.js";

const ceiling = (path, maxRank) => ({ path, maxRank });
const layer = (providerId, rank, entries, extra = {}) => ({
  layer: `custom:${rank}`, providerId, rank, entries, ...extra,
});
const resolve = (layers, ceilings = []) => resolveConfigurationSnapshot({
  layers, ceilings, configuredRanks: [0, 1, 2],
});
const inspect = (snapshot, ...path) => inspectResolvedPath(snapshot, path);
const validationError = (error) => error.code === "VALIDATION_ERROR";

test("source-local ceilings intersect logical ceilings without constraining base fallback", () => {
  const snapshot = resolve([
    layer("base", 2, { cfg: { local: "base", global: "base" } }),
    layer("view", 1, { cfg: { local: "view", global: "view" } }, {
      sourcePath: ["cfg", "instances", "blue"],
      sourceCeilings: [ceiling(["cfg", "local"], 0)],
    }),
  ], [ceiling(["cfg", "global"], 0)]);
  assert.deepEqual(snapshot.entries, { cfg: { local: "base" } });
  const local = inspect(snapshot, "cfg", "local");
  assert.equal(local.effectiveProviderId, "base");
  assert.deepEqual(local.contributions.map(({ value }) => value), ["base", "view"]);
  assert.equal(inspect(snapshot, "cfg", "global").present, false);
});

test("logical and source-local ancestor restrictions intersect by the tighter rank", () => {
  for (const [global, source] of [
    [[ceiling(["cfg"], 0)], [ceiling(["cfg", "x"], 2)]],
    [[ceiling(["cfg", "x"], 2)], [ceiling(["cfg"], 0)]],
  ]) {
    const snapshot = resolve([
      layer("base", 0, { cfg: { x: "base" } }),
      layer("view", 1, { cfg: { x: "view" } }, { sourceCeilings: source }),
    ], global);
    assert.deepEqual(snapshot.entries, { cfg: { x: "base" } });
    assert.equal(inspect(snapshot, "cfg", "x").effectiveProviderId, "base");
  }
});

test("logical stack order remains independent from physical rank", () => {
  const snapshot = resolve([
    layer("base", 2, { cfg: { x: "base" } }),
    layer("view", 0, { cfg: { x: "view" } }, {
      sourcePath: ["cfg", "instances", "blue"],
      sourceCeilings: [ceiling(["cfg", "x"], 0)],
    }),
  ]);
  const result = inspect(snapshot, "cfg", "x");
  assert.equal(result.effectiveValue, "view");
  assert.equal(result.effectiveProviderId, "view");
  assert.deepEqual(result.effectiveSourcePath, ["cfg", "instances", "blue"]);
  assert.equal(result.contributions[1].origin.rank, 0);
});

test("source-local absent descendants block destructive replacements and preserve siblings", () => {
  const sourceCeilings = [ceiling(["cfg", "locked"], 0)];
  for (const replacement of [null, 7, [], ["replacement"]]) {
    const snapshot = resolve([
      layer("base", 0, { cfg: { open: "base" } }),
      layer("view", 1, { cfg: replacement }, { sourceCeilings }),
    ]);
    assert.deepEqual(snapshot.entries, { cfg: { open: "base" } });
    assert.equal(inspect(snapshot, "cfg").effectiveProviderId, "base");
  }
  const snapshot = resolve([
    layer("base", 0, { cfg: { locked: "base", open: "base" } }),
    layer("view", 1, { cfg: { locked: "view", open: "view" } }, { sourceCeilings }),
  ]);
  assert.deepEqual(snapshot.entries, { cfg: { locked: "base", open: "view" } });
  assert.equal(inspect(snapshot, "cfg").effectiveProviderId, undefined);
});

test("source-local array descendants retain atomic whole-array semantics", () => {
  for (const replacement of [[], [{ x: "view" }], {}, null]) {
    const snapshot = resolve([
      layer("base", 0, { items: [{ x: "base" }] }),
      layer("view", 1, { items: replacement }, {
        sourceCeilings: [ceiling(["items", "0", "x"], 0)],
      }),
    ]);
    assert.deepEqual(snapshot.entries.items, [{ x: "base" }]);
    assert.equal(inspect(snapshot, "items", "0", "x").effectiveProviderId, "base");
  }
});

test("source-local policy is confined to its entry, including equal-valued provenance", () => {
  const snapshot = resolve([
    layer("base", 0, { x: "equal" }),
    layer("denied", 2, { x: "denied" }, { sourceCeilings: [ceiling(["x"], 0)] }),
    layer("allowed", 2, { x: "equal" }),
  ]);
  assert.equal(inspect(snapshot, "x").effectiveValue, "equal");
  assert.equal(inspect(snapshot, "x").effectiveProviderId, "allowed");
});

test("explicit trusted emergency bypasses both numeric limits for only that entry", () => {
  const sourceCeilings = [ceiling(["x"], 0)];
  const snapshot = resolve([
    layer("base", 0, { x: "base" }),
    layer("emergency", 2, { x: "emergency" }, { sourceCeilings, trustedEmergency: true }),
    layer("ordinary", 2, { x: "ordinary" }, { sourceCeilings }),
  ], [ceiling(["x"], 0)]);
  assert.equal(inspect(snapshot, "x").effectiveProviderId, "emergency");
  const namedOnly = resolve([
    layer("base", 0, { x: "base" }),
    layer("emergency", 2, { x: "ordinary" }, { layer: "emergency", sourceCeilings }),
  ]);
  assert.equal(inspect(namedOnly, "x").effectiveProviderId, "base");
});

test("all source-local ranks validate even for empty or emergency entries", () => {
  for (const entries of [{}, { x: 1 }]) {
    for (const trustedEmergency of [false, true]) {
      for (const maxRank of [99, NaN, Infinity]) {
        assert.throws(() => resolve([
          layer("source", 2, entries, {
            trustedEmergency, sourceCeilings: [ceiling(["x"], maxRank)],
          }),
        ]), validationError);
      }
    }
  }
  assert.throws(() => resolve([
    layer("source", 99, {}, { trustedEmergency: true, sourceCeilings: [] }),
  ]), validationError);
  assert.throws(() => resolve([
    layer("source", 2, {}, { trustedEmergency: true }),
  ], [ceiling(["x"], 99)]), validationError);
  const snapshot = resolve([
    layer("source", 2, { x: 1 }, { sourceCeilings: [ceiling(["x"], 1)] }),
  ]);
  assert.deepEqual(snapshot.entries, {}, "configured ceiling need not have a loaded entry");
});

test("native layer and input schemas capture source ceilings and retain literal paths", () => {
  const source = layer("source", 1, { "literal.dot": { 日本語: 2 }, literal: { dot: 3 } }, {
    sourceCeilings: [ceiling(["literal.dot", "日本語"], 0)],
  });
  assert.deepEqual(resolutionLayerSchema.parse(source).sourceCeilings, source.sourceCeilings);
  const parsed = resolutionSnapshotInputSchema.parse({
    layers: [source], configuredRanks: [0, 1], ceilings: [],
  });
  const snapshot = resolveConfigurationSnapshot(parsed);
  source.sourceCeilings[0].path[0] = "changed";
  source.sourceCeilings[0].maxRank = 1;
  assert.deepEqual(snapshot.entries, { "literal.dot": {}, literal: { dot: 3 } });
  assert.deepEqual(snapshot.layers[0].sourceCeilings, [ceiling(["literal.dot", "日本語"], 0)]);
  assert.ok(Object.isFrozen(snapshot.layers[0].sourceCeilings));
  assert.ok(Object.isFrozen(snapshot.layers[0].sourceCeilings[0].path));
});

test("invalid source policy shape and accessors fail before executing code", () => {
  let calls = 0;
  const accessor = { get path() { calls++; return ["x"]; }, maxRank: 0 };
  for (const sourceCeilings of [null, {}, [accessor], [ceiling(["__proto__"], 0)]]) {
    assert.throws(() => resolve([
      layer("source", 1, {}, { sourceCeilings, trustedEmergency: true }),
    ]), validationError);
  }
  assert.equal(calls, 0);
  assert.deepEqual(resolve([layer("source", 1, { x: 1 })]).entries, { x: 1 });
  assert.deepEqual(resolve([layer("source", 1, { x: 1 }, { sourceCeilings: [] })]).entries, { x: 1 });
});
