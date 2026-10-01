import assert from "node:assert/strict";
import * as engine from "../src/index.ts";
import { beginResolutionObservation, endResolutionObservation } from "../src/resolution-observation.ts";
import { checkCompactSnapshots } from "./compact-behavior.mjs";

checkCompactSnapshots(engine, assert);
function countGraph(root) {
  const visited = new Set();
  const pending = [root];
  let edges = 0;
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    for (const key of Object.keys(value)) { edges++; pending.push(Object.getOwnPropertyDescriptor(value, key).value); }
  }
  return { nodes: visited.size, edges };
}
for (const depth of [4, 8, 12, 30]) {
  let value = { leaf: 1 };
  for (let index = 0; index < depth; index++) value = { left: value, right: value };
  beginResolutionObservation();
  const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [], layers: [{ layer: "core", providerId: "p", rank: 0, entries: { cfg: value } }] });
  const work = endResolutionObservation();
  assert.deepEqual(countGraph(snapshot.entries), { nodes: depth + 2, edges: 2 * depth + 2 });
  assert.equal(work.originNodes, depth + 3);
  assert.equal(work.originEdges, 2 * depth + 2);
  assert.equal(work.retainedOriginNodes, depth + 3);
  assert.equal(work.retainedOriginEdges, 2 * depth + 2);
  assert.equal(work.mergeEdges, 2 * depth + 2);
  assert.ok(work.copyNodes < 5 * (depth + 8));
  console.log("compact DAG counts", { depth, ...countGraph(snapshot.entries), ...work });
  beginResolutionObservation();
  engine.inspectResolvedPath(snapshot, ["cfg"]);
  engine.inspectResolvedPath(snapshot, ["missing"]);
  const inspection = endResolutionObservation();
  assert.equal(inspection.inspectSteps, 4);
  assert.equal(inspection.mergeNodes, undefined);
  assert.equal(inspection.originEdges, undefined);
  assert.equal(inspection.retainedOriginEdges, undefined);
  assert.equal(inspection.freezeNodes, undefined);
}
console.log("fresh-source compact fixtures PASS");

for (const depth of [12, 30]) {
  let value = { leaf: 1 };
  for (let index = 0; index < depth; index++) value = { left: value, right: value };
  const path = ["a", ...Array(depth).fill("left"), "leaf"];
  beginResolutionObservation();
  const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1], ceilings: [{ path, maxRank: 0 }], layers: [
    { layer: "core", providerId: "low", rank: 0, entries: { a: value, b: value } },
    { layer: "user", providerId: "high", rank: 1, entries: { a: value, b: value } },
  ] });
  const work = endResolutionObservation();
  assert.deepEqual(countGraph(snapshot.entries), { nodes: 2 * depth + 3, edges: 4 * depth + 4 });
  assert.equal(work.mergeNodes, 3 * depth + 5);
  assert.equal(work.originNodes, 3 * depth + 7);
  assert.equal(work.originEdges, 6 * depth + 7);
  assert.equal(work.retainedOriginNodes, 2 * depth + 5);
  assert.equal(work.retainedOriginEdges, 4 * depth + 4);
  assert.equal(engine.inspectResolvedPath(snapshot, path).effectiveProviderId, "low");
  assert.equal(engine.inspectResolvedPath(snapshot, ["b", ...path.slice(1)]).effectiveProviderId, "high");
  console.log("split-context DAG counts", { depth, ...countGraph(snapshot.entries), ...work });
}
