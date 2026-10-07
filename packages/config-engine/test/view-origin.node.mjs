import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfigurationSnapshot, inspectResolvedPath, resolutionOriginSchema } from "../dist/index.js";

test("view tier provenance distinguishes the same physical provider without invented rank", () => {
  const base = { layer: "base", providerId: "disk", rank: 0, sourcePath: ["example"], entries: { example: { panel: { a: 1, b: 2 }, equal: "same", list: [1, 2] } } };
  const view = { ...base, sourcePath: ["example", "instances", "literal.dot"], entries: { example: { panel: { a: 3 }, equal: "same", list: [3] } } };
  const snapshot = resolveConfigurationSnapshot({ configuredRanks: [0, 1], ceilings: [], layers: [base, { layer: "high", providerId: "high", rank: 1, sourcePath: ["example"], entries: { example: { panel: { a: 99 } } } }, view] });
  assert.deepEqual(snapshot.entries.example.panel, { a: 3, b: 2 });
  assert.deepEqual(snapshot.entries.example.list, [3]);
  assert.equal(inspectResolvedPath(snapshot, ["example", "panel"]).effectiveLayer, undefined);
  const equal = inspectResolvedPath(snapshot, ["example", "equal"]);
  assert.deepEqual(equal.effectiveSourcePath, view.sourcePath);
  assert.equal(equal.effectiveLayer, "base");
  assert.equal(equal.contributions[2].origin.rank, 0);
  assert.deepEqual(equal.contributions[0].origin.sourcePath, ["example"]);
  assert.throws(() => resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [], layers: [view, view] }), { code: "VALIDATION_ERROR" });
  assert.throws(() => inspectResolvedPath(structuredClone(snapshot), []), { code: "VALIDATION_ERROR" });
  assert.equal(resolutionOriginSchema.safeParse({ layer: "base", providerId: "disk", rank: 0, sourcePath: [] }).success, false);
});
