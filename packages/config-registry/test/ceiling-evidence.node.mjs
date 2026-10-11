import assert from "node:assert/strict";
import { test } from "node:test";
import { registeredCeilingEvidence, registeredCeilingEvidenceSchema, validateRegisteredCeilingNames } from "../dist/index.js";
import { createRegistryAdapter } from "../dist/internal/server-adapter.js";
import { resolveConfigurationSnapshot, validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import { service, fragment } from "./fixtures/requests.mjs";

const limit = (name) => ({ maxOverrideLayer: name });
const names = ["custom:base", "scope:abc", "incident"];
const raw = (entries, rank) => ({ layer: names[rank], providerId: `p${rank}`, rank, entries });
function setup(schema) {
  const registry = createRegistryAdapter({ defaultEnvironment: "dev" });
  const prepared = registry.prepare({ ...service(), schema });
  assert.equal(prepared.result.success, true, JSON.stringify(prepared.result));
  prepared.publish();
  return registry;
}
function evidence(registry, layers) {
  return registeredCeilingEvidence(registry.reader, { environment: "dev", registryRevision: registry.revision, layerNames: names, candidates: layers });
}
function resolved(registry, layers) {
  const policy = evidence(registry, layers);
  assert.equal(registeredCeilingEvidenceSchema.safeParse(policy).success, true);
  assert.ok(Object.isFrozen(policy.ceilings));
  return resolveConfigurationSnapshot({ layers, ceilings: policy.ceilings, configuredRanks: [0, 1, 2] }).entries;
}

test("raw candidates and missing declarations compile inherited minimum ceilings", () => {
  const registry = setup({ type: "object", "x-weaver": limit(names[1]), properties: {
    locked: { type: "number", "x-weaver": limit(names[0]) },
    open: { type: "number", "x-weaver": limit(names[2]) },
  } });
  assert.deepEqual(resolved(registry, [raw({ svc: { locked: 1, open: 1 } }, 0), raw({ svc: { locked: 2, open: 2 } }, 1), raw({ svc: { open: 3 } }, 2)]), { svc: { locked: 1, open: 2 } });
  for (const destructive of [null, 3, []]) {
    const layers = [raw({ svc: { open: 1 } }, 0), raw({ svc: destructive }, 1)];
    assert.deepEqual(resolved(registry, layers), { svc: { open: 1 } });
  }
  const empty = evidence(registry, []);
  assert.ok(empty.ceilings.some((item) => item.path.join("/") === "svc/locked"));
  assert.deepEqual(resolved(registry, [raw({ svc: [] }, 1)]), {});
});

test("pattern/additional members and tuples use union raw keys while arrays remain atomic", () => {
  const registry = setup({ type: "object", properties: {
    map: { type: "object", patternProperties: { "^lock": { type: "number", "x-weaver": limit(names[0]) } }, additionalProperties: { type: "number", "x-weaver": limit(names[1]) } },
    list: { type: "array", items: [{ type: "object", properties: { x: { type: "number", "x-weaver": limit(names[0]) } } }] },
  } });
  const layers = [raw({ svc: { map: { locked: 1 }, list: [{ x: 1 }] } }, 0), raw({ svc: { map: { locked: 9, next: 9 }, list: [] } }, 2)];
  assert.deepEqual(resolved(registry, layers), { svc: { map: { locked: 1 }, list: [{ x: 1 }] } });
  assert.equal(evidence(registry, [raw({ svc: { list: [] } }, 0)]).ceilings.some((item) => item.path.includes("0")), true, "declared tuple positions protect even missing items");
});

test("missing future tuple children prevent atomic replacement without inventing wildcard indices", () => {
  const item = { type: "object", properties: { x: { type: "number", "x-weaver": limit(names[0]) } } };
  const tuple = setup({ type: "object", properties: { list: { type: "array", items: [{ type: "number" }, { type: "number" }, item] } } });
  const layers = [raw({ svc: { list: [] } }, 0), raw({ svc: { list: [1] } }, 2)];
  assert.deepEqual(resolved(tuple, layers).svc.list, []);
  assert.ok(evidence(tuple, layers).ceilings.some((entry) => entry.path.join("/") === "svc/list/2/x"));
  const wildcard = setup({ type: "object", properties: { list: { type: "array", items: item } } });
  assert.equal(evidence(wildcard, [raw({ svc: { list: [] } }, 0)]).ceilings.length, 0);
});

test("declared tuple ceilings survive object/array/null unions with only non-array or absent raw candidates", () => {
  const list = { type: ["object", "array", "null"], additionalProperties: true,
    items: [{ type: "number", "x-weaver": limit(names[0]) }] };
  const registry = setup({ type: "object", properties: { list } });
  for (const base of [{}, null, undefined, []]) for (const upper of [null, {}, []]) {
    const lower = base === undefined ? {} : { list: base };
    const layers = [raw({ svc: lower }, 0), raw({ svc: { list: upper } }, 2)];
    assert.ok(evidence(registry, layers).ceilings.some((c) => c.path.join("/") === "svc/list/0" && c.maxRank === 0), JSON.stringify({ base, upper }));
    // Empty object imports merge structurally; they do not write the protected index.
    const expected = upper !== null && !Array.isArray(upper) && (base === null || base === undefined) ? { list: {} } : lower;
    assert.deepEqual(resolved(registry, layers).svc, expected);
  }
  assert.ok(evidence(registry, []).ceilings.some((c) => c.path.join("/") === "svc/list/0"));
});

test("declared tuple and numeric object policies intersect without inventing wildcard members or inactive branches", () => {
  const tuple = { type: ["object", "array", "null"], additionalProperties: true,
    properties: { "0": { type: "number", "x-weaver": limit(names[1]) } },
    items: [{ type: "number", "x-weaver": limit(names[0]) }] };
  const registry = setup({ type: "object", properties: { list: tuple } });
  const layers = [raw({ svc: { list: { "0": 1 } } }, 0), raw({ svc: { list: { "0": 9 } } }, 1)];
  const ranks = new Set(evidence(registry, layers).ceilings.filter((c) => c.path.join("/") === "svc/list/0").map((c) => c.maxRank));
  assert.deepEqual(ranks, new Set([0, 1]));
  assert.deepEqual(resolved(registry, layers).svc.list, { "0": 1 });
  const wildcard = setup({ type: "object", properties: { list: { type: ["object", "array", "null"], additionalProperties: true,
    items: { type: "number", "x-weaver": limit(names[0]) } } } });
  for (const list of [{}, null, undefined, []]) {
    assert.deepEqual(evidence(wildcard, [raw({ svc: list === undefined ? {} : { list } }, 0)]).ceilings, []);
  }
  assert.deepEqual(resolved(wildcard, [raw({ svc: { list: [1] } }, 0), raw({ svc: { list: null } }, 2)]).svc.list, [1]);
  assert.ok(evidence(wildcard, [raw({ svc: { list: {} } }, 0), raw({ svc: { list: [9] } }, 2)]).ceilings.some((c) => c.path.join("/") === "svc/list/0"));
  for (const keyword of ["anyOf", "oneOf"]) {
    const conditional = setup({ type: "object", properties: { list: { type: ["object", "array"], additionalProperties: true,
      [keyword]: [{ type: "object", additionalProperties: true }, { type: "array", items: tuple.items }] } } });
    const objects = [raw({ svc: { list: {} } }, 0), raw({ svc: { list: { open: 9 } } }, 2)];
    assert.deepEqual(evidence(conditional, objects).ceilings, []);
    assert.deepEqual(resolved(conditional, objects).svc.list, { open: 9 });
  }
});

test("allOf intersects; candidate-conditioned alternatives union all raw witnesses without choosing first", () => {
  for (const keyword of ["anyOf", "oneOf"]) {
    const branch = (kind, name) => ({ type: "object", required: ["kind"], properties: {
      kind: { type: "string", const: kind }, value: { type: "number", "x-weaver": limit(name) },
    } });
    const registry = setup({ type: "object", [keyword]: [branch("open", names[2]), branch("locked", names[0])] });
    assert.equal(resolved(registry, [raw({ svc: { kind: "open", value: 1 } }, 2)]).svc.value, 1);
    const layers = [raw({ svc: { kind: "locked", value: 1 } }, 0), raw({ svc: { kind: "open", value: 9 } }, 2)];
    assert.equal(resolved(registry, layers).svc.value, 1);
    assert.equal(resolved(registry, [raw({ svc: { kind: "unknown", value: 9 } }, 2)]).svc.value, undefined);
  }
  const registry = setup({ type: "object", allOf: [
    { type: "object", properties: { x: { type: "number", "x-weaver": limit(names[2]) } } },
    { type: "object", properties: { x: { type: "number", "x-weaver": limit(names[0]) } } },
  ] });
  assert.equal(resolved(registry, [raw({ svc: { x: 1 } }, 0), raw({ svc: { x: 2 } }, 1)]).svc.x, 1);
});

test("validation visits actual schema graph positions including inactive branches, never defaults/examples", () => {
  const leaf = { type: "string", "x-weaver": limit("unknown") };
  for (const schema of [
    { type: "object", properties: { hidden: leaf } },
    { type: "object", patternProperties: { x: leaf } },
    { type: "object", additionalProperties: leaf },
    { type: "object", properties: { list: { type: "array", items: [leaf] } } },
    { type: "object", anyOf: [{ type: "object" }, { type: "object", properties: { hidden: leaf } }] },
    { type: "object", not: { type: "object", properties: { hidden: leaf } } },
  ]) assert.throws(() => validateRegisteredCeilingNames(schema, names), { code: "VALIDATION_ERROR" });
  assert.doesNotThrow(() => validateRegisteredCeilingNames({ type: "object", default: leaf, examples: [leaf], const: leaf }, names));
  assert.doesNotThrow(() => validateRegisteredCeilingNames({ type: "object", "x-weaver": limit(names[0]), not: { type: "object", required: ["bad"] } }, names));
});

test("positive ceilings coexist with native negative assertions at root, nested and allOf positions", () => {
  const schema = { type: "object", properties: {
    flag: { type: "string", "x-weaver": limit(names[0]) }, bad: { type: "boolean" },
  }, not: { type: "object", required: ["bad"], additionalProperties: true } };
  for (const wrap of [(s) => s, (s) => ({ type: "object", additionalProperties: true, allOf: [s] }), (s) => ({ type: "object", properties: { nested: s } })]) {
    const nested = wrap(schema), registry = setup(nested);
    const value = (flag, bad = false) => {
      const data = { flag, ...(bad ? { bad: true } : {}) };
      return nested.properties?.nested ? { nested: data } : data;
    };
    assert.equal(validateEffectiveConfiguration(nested, value("safe")).valid, true);
    assert.equal(validateEffectiveConfiguration(nested, value("safe", true)).valid, false);
    assert.deepEqual(resolved(registry, [raw({ svc: value("safe") }, 0), raw({ svc: value("upper") }, 2)]).svc, value("safe"));
  }
});

test("negative-only and double-negative annotations emit no positive ceiling or member path", () => {
  const annotated = { type: "object", additionalProperties: true, required: ["bad"], properties: { bad: { type: "boolean", "x-weaver": limit(names[0]) } }, "x-weaver": limit(names[0]) };
  for (const negative of [annotated, { type: "object", additionalProperties: true, not: annotated }]) {
    const schema = { type: "object", properties: { open: { type: "number" }, bad: { type: "boolean" } }, not: negative };
    const registry = setup(schema);
    const value = negative === annotated ? { open: 9 } : { open: 9, bad: true };
    assert.equal(validateEffectiveConfiguration(schema, value).valid, true);
    const layers = [raw({ svc: value }, 2)];
    assert.deepEqual(evidence(registry, layers).ceilings, []);
    assert.deepEqual(resolved(registry, layers).svc, value);
  }
});

test("shared positive/negative nodes retain only positive occurrence ceilings", () => {
  const shared = { type: "number", "x-weaver": limit(names[0]) };
  const registry = setup({ type: "object", properties: { positive: shared }, not: { type: "object", required: ["negative"], properties: { negative: shared } } });
  const layers = [raw({ svc: { positive: 1 } }, 0), raw({ svc: { positive: 9 } }, 2)];
  assert.deepEqual(evidence(registry, layers).ceilings.map((c) => c.path), [["svc", "positive"], ["svc", "positive"]]);
  assert.equal(resolved(registry, layers).svc.positive, 1);
});

test("not participates in native alternative eligibility without emitting its annotations", () => {
  for (const keyword of ["anyOf", "oneOf"]) {
    const locked = { type: "object", required: ["kind"], properties: { kind: { type: "string" }, value: { type: "number", "x-weaver": limit(names[0]) } },
      not: { type: "object", additionalProperties: true, properties: { kind: { type: "string", const: "open" } } } };
    const open = { type: "object", required: ["kind"], properties: { kind: { type: "string", const: "open" }, value: { type: "number" } } };
    const schema = { type: "object", additionalProperties: true, [keyword]: [locked, open] }, registry = setup(schema);
    assert.equal(validateEffectiveConfiguration(locked, { kind: "open", value: 9 }).valid, false);
    assert.equal(validateEffectiveConfiguration(schema, { kind: "open", value: 9 }).valid, true);
    assert.equal(resolved(registry, [raw({ svc: { kind: "open", value: 9 } }, 2)]).svc.value, 9);
    assert.equal(resolved(registry, [raw({ svc: { kind: "locked", value: 1 } }, 0), raw({ svc: { kind: "locked", value: 9 } }, 2)]).svc.value, 1);
  }
});

test("fragment anchors and literal segments contribute policy without inventing wildcard members", () => {
  const registry = setup({ type: "object", properties: { "literal.dot": { type: "object", properties: { 雪: { type: "number", "x-weaver": limit(names[0]) } } } } });
  const prepared = registry.prepare({ ...fragment(), schema: { type: "object", additionalProperties: true, "x-weaver": limit(names[0]) } });
  assert.equal(prepared.result.success, true); prepared.publish();
  const layers = [raw({ svc: { "literal.dot": { 雪: 1 }, plugins: { p: { arbitrary: { x: 1 } } } } }, 0), raw({ svc: { "literal.dot": { 雪: 2 }, plugins: { p: { arbitrary: { x: 2 } } } } }, 2)];
  const result = resolved(registry, layers);
  assert.equal(result.svc["literal.dot"].雪, 1);
  assert.equal(result.svc.plugins.p.arbitrary.x, 1);
});
