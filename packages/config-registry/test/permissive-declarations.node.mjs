import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfigurationSnapshot, validatePartialConfiguration, validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import {
  createCanonicalSchemaRegistry,
  createRegisteredReadProjection,
  registeredMutationEvidence,
  registeredMutationEvidenceSchema,
  schemaWriteSupport,
} from "../dist/index.js";

function projection(schema, value, layers) {
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
  const registered = registry.register({ serviceId: "alpha", environment: "test",
    owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema });
  assert.equal(registered.success, true);
  const snapshot = resolveConfigurationSnapshot({ configuredRanks: [0, 1], ceilings: [],
    layers: layers ?? [{ layer: "base", providerId: "base", rank: 0, entries: { alpha: value } }] });
  return createRegisteredReadProjection(registry, snapshot,
    { identity: { environment: "test", scopePath: [] }, revision: "one" });
}

test("explicit true declares arbitrary JSON descendants for both projection and structural writes", () => {
  const schema = { type: "object", additionalProperties: true };
  const value = { arbitrary: { list: [{ "0": { nullable: null, flags: [true, 1, "雪"] } }] } };
  const read = projection(schema, value);
  assert.deepEqual(read.get("/alpha"), value);
  assert.equal(read.get("/alpha/arbitrary/list/0/0/nullable"), null);
  assert.equal(schemaWriteSupport(schema, [], value, value, {}).declared, true);
  assert.deepEqual(schemaWriteSupport(schema, ["arbitrary", "list", "0", "0", "nullable"], null, value, value),
    { declared: true, arrayIndex: true, ambiguous: false });
  const evidence = registeredMutationEvidence(schema, ["arbitrary", "list", "0"], value);
  assert.ok(registeredMutationEvidenceSchema.safeParse(evidence).success);
  assert.equal(evidence.unconstrained, true);
  assert.equal(evidence.declared, true);
  assert.throws(() => read.get("/other/arbitrary"), { code: "SCHEMA_NOT_REGISTERED" });
});

test("omitted/false wildcards stay undeclared; named, pattern and schema-valued declarations accumulate", () => {
  for (const schema of [{ type: "object" }, { type: "object", additionalProperties: false }]) {
    assert.equal(schemaWriteSupport(schema, ["unknown"], 1, { unknown: 1 }, {}).declared, false);
    assert.throws(() => projection(schema, { unknown: 1 }).get("/alpha/unknown"), { code: "SCHEMA_NOT_REGISTERED" });
  }
  const schema = { type: "object", additionalProperties: true,
    properties: { public: { type: "string" }, protected: { type: "object", additionalProperties: true,
      "x-weaver": { sensitive: true } } },
    patternProperties: { "^public$": { type: "string", "x-weaver": { sensitive: true } } } };
  const value = { public: "hidden", protected: { deep: ["hidden"] }, ordinary: [1, { x: 2 }] };
  const read = projection(schema, value);
  assert.deepEqual(read.get("/alpha"), { ordinary: [1, { x: 2 }] });
  assert.throws(() => read.get("/alpha/protected/deep/0"), { code: "FORBIDDEN" });
  assert.equal(registeredMutationEvidence(schema, ["protected", "deep", "0"], value).sensitive, true);
  const wildcard = { type: "object", additionalProperties: { type: "object", additionalProperties: true } };
  assert.deepEqual(projection(wildcard, { x: { a: [1] } }).get("/alpha/x/a"), [1]);
});

test("unrestricted array items retain JSON declarations but tuples retain their declared bounds", () => {
  const schema = { type: "object", properties: { values: { type: "array" } } };
  const value = { values: [null, { nested: [true] }] };
  assert.deepEqual(projection(schema, value).get("/alpha/values"), value.values);
  assert.equal(schemaWriteSupport(schema, ["values", "1", "nested", "0"], false, value, value).arrayIndex, true);
  const tuple = { type: "array", items: [{ type: "string" }] };
  assert.equal(schemaWriteSupport(tuple, ["1"], 2, ["first", 2], []).declared, false);
});

test("wildcard composition never erases applicable metadata and multiple public alternatives work", () => {
  const open = { type: "object", additionalProperties: true };
  const restricted = { type: "object", additionalProperties: true,
    properties: { hidden: { type: "string", "x-weaver": { sensitive: true } } } };
  for (const keyword of ["allOf", "anyOf"]) {
    const schema = { type: "object", [keyword]: [open, restricted] };
    assert.deepEqual(projection(schema, { hidden: "secret", extra: 1 }).get("/alpha"), { extra: 1 });
    assert.equal(registeredMutationEvidence(schema, ["hidden"], { hidden: "secret" }).sensitive, true);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const branches = keyword === "oneOf" ? [open, { type: "object", required: ["absent"], properties: { absent: { type: "string" } } }] : [open, open];
    const schema = { type: "object", [keyword]: branches };
    const value = { extra: { list: [1, 2] } };
    assert.deepEqual(projection(schema, value).get("/alpha"), value);
    assert.equal(registeredMutationEvidence(schema, ["extra", "list"], value).ambiguous, false);
  }
});

test("explicit wildcard does not expose secret references, mounts or tainted source descendants", () => {
  const schema = { type: "object", additionalProperties: true };
  const value = { secret: { _weaver: "secret-ref", key: "PRIVATE" },
    source: { public: 1, hidden: { _weaver: "secret-ref", key: "PRIVATE" } },
    alias: { _weaver: "mount", source: "alpha.source" }, safe: [1, 2] };
  const read = projection(schema, value);
  assert.deepEqual(read.get("/alpha"), { source: { public: 1 }, safe: [1, 2] });
  for (const path of ["/alpha/secret", "/alpha/secret/key", "/alpha/alias", "/alpha/alias/hidden"])
    assert.throws(() => read.get(path), { code: "FORBIDDEN" });
  assert.equal(registeredMutationEvidence(schema, ["secret", "key"], value).reference, true);
  assert.equal(JSON.stringify(read.entries()).includes("PRIVATE"), false);
});

test("array ancestry survives nonnumeric members and prospective object replacement", () => {
  const schema = { type: "object", properties: { cfg: { type: ["object", "array"],
    properties: { a: { type: "number" }, "0": { type: "number" } }, items: { type: "number" } } } };
  for (const key of ["a", "0"]) {
    const result = schemaWriteSupport(schema, ["cfg", key], 9, { cfg: { [key]: 9 } }, { cfg: [1, 2] });
    assert.equal(result.arrayIndex, true, key);
  }
  assert.equal(schemaWriteSupport(schema, ["cfg", "0"], 9, { cfg: { "0": 9 } }, { cfg: { "0": 1 } }).arrayIndex, false);
  assert.equal(schemaWriteSupport(schema, ["cfg"], { a: 9 }, { cfg: { a: 9 } }, { cfg: [1, 2] }).arrayIndex, false);
});

test("whole union payload declarations follow the replacement container, not its previous shape", () => {
  for (const type of [["object", "array"], ["object", "array", "null"]]) {
    const cfg = { type, properties: { a: { type: "number" }, "0": { type: "number" } }, items: { type: "number" } };
    const schema = { type: "object", properties: { cfg } };
    const values = (items) => items.filter((value) => value !== null || type.includes("null"));
    for (const previous of values([{}, { a: 1 }, { "0": 1 }, [], [1], [1, 2], null, undefined])) {
      for (const incoming of values([[], [5], [5, 6], { a: 9 }, { "0": 9 }, null])) {
        const before = previous === undefined ? {} : { cfg: previous }, after = { cfg: incoming };
        assert.equal(validatePartialConfiguration(schema, after).valid, true);
        assert.equal(validateEffectiveConfiguration(schema, after).valid, true);
        assert.deepEqual(schemaWriteSupport(schema, ["cfg"], incoming, after, before),
          { declared: true, arrayIndex: false, ambiguous: false }, JSON.stringify({ previous, incoming }));
      }
    }
  }
});

test("new payload membership is independent of a different effective overlay and preserves nested unions", () => {
  const member = { type: ["object", "array", "null"], properties: { a: { type: "number" }, "0": { type: "number" } }, items: { type: "number" }, oneOf: [
    { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
    { type: "array", items: { type: "number" } }, { type: "null" },
  ] };
  const schema = { type: "object", properties: { cfg: { type: ["object", "array"], properties: { group: member }, items: member } } };
  const before = { cfg: { group: { a: 1 } } }, incoming = [[5, 6], { a: 9 }, null];
  assert.equal(validatePartialConfiguration(schema, { cfg: incoming }).valid, true);
  for (const candidate of [{ cfg: incoming }, before]) {
    assert.equal(validateEffectiveConfiguration(schema, candidate).valid, true);
    assert.deepEqual(schemaWriteSupport(schema, ["cfg"], incoming, candidate, before),
      { declared: true, arrayIndex: false, ambiguous: false });
  }
});

test("declared array item type errors remain value validation, not generic path traversal", () => {
  for (const additionalProperties of [false, true]) {
    const cfg = { type: ["object", "array"], properties: { "0": { type: "number" } }, items: { type: "number" }, additionalProperties };
    const schema = { type: "object", properties: { cfg } };
    for (const incoming of [[5, "invalid"], [false], [null], [{ a: 1 }], [[1]]]) {
      const candidate = { cfg: incoming };
      assert.equal(validatePartialConfiguration(schema, candidate).valid, false);
      assert.equal(validateEffectiveConfiguration(schema, candidate).valid, false);
      assert.deepEqual(schemaWriteSupport(schema, ["cfg"], incoming, candidate, { cfg: {} }),
        { declared: true, arrayIndex: false, ambiguous: false }, JSON.stringify({ additionalProperties, incoming }));
    }
  }
  const tuple = { type: "array", items: [{ type: "number" }] };
  assert.deepEqual(schemaWriteSupport(tuple, [], [1, 2], [1, 2], []),
    { declared: false, arrayIndex: false, ambiguous: false });
});

test("whole atomic array composition selects incoming branches rather than a different effective array", () => {
  const branch = (key) => ({ type: "array", items: { type: "object", properties: { [key]: { type: "number" } }, required: [key], additionalProperties: false } });
  for (const keyword of ["anyOf", "oneOf"]) {
    const schema = { type: "object", properties: { cfg: { type: "array", [keyword]: [branch("a"), branch("b")] } } };
    const value = [{ b: 2 }], candidate = { cfg: [{ a: 3 }] }, before = { cfg: [{ a: 1 }] };
    assert.equal(validatePartialConfiguration(schema, { cfg: value }).valid, true);
    assert.equal(validateEffectiveConfiguration(schema, candidate).valid, true);
    assert.deepEqual(schemaWriteSupport(schema, ["cfg"], value, candidate, before),
      { declared: true, arrayIndex: false, ambiguous: false }, keyword);
    assert.equal(schemaWriteSupport(schema, ["cfg"], [], candidate, before).declared, keyword === "anyOf");
  }
});
