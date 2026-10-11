import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEffectiveConfiguration as effective, validatePartialConfiguration as partial } from "../dist/index.js";

const object = { type: "object", additionalProperties: true };
const requiresBad = { ...object, required: ["bad"] };
const negative = { ...object, properties: { flag: { type: "string" }, bad: { type: "boolean" } }, not: requiresBad };

test("not evaluates required as a complete predicate while outer partial omissions remain valid", () => {
  for (const validate of [partial, effective]) {
    assert.equal(validate(negative, { flag: "safe" }).valid, true);
    const rejected = validate(negative, { flag: "safe", bad: true });
    assert.equal(rejected.valid, false);
    assert.deepEqual(rejected.errors.map((e) => e.message), ["Value must not match the not schema"]);
  }
  const ordinary = { ...object, required: ["ordinary"], minProperties: 2, not: requiresBad };
  assert.equal(partial(ordinary, {}).valid, true);
  assert.equal(effective(ordinary, {}).valid, false);
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    assert.equal(partial({ ...object, [keyword]: [requiresBad] }, {}).valid, true);
    assert.equal(effective({ ...object, [keyword]: [requiresBad] }, {}).valid, false);
  }
});

test("nested negative predicates and inner positive compositions retain complete native constraints", () => {
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const inner = { ...object, [keyword]: [requiresBad] };
    assert.equal(partial({ ...object, not: inner }, {}).valid, true);
    assert.equal(partial({ ...object, not: inner }, { bad: true }).valid, false);
    assert.equal(partial({ ...object, [keyword]: [negative] }, { flag: "safe" }).valid, true);
    assert.equal(partial({ ...object, [keyword]: [negative] }, { bad: true }).valid, false);
  }
  const nested = { ...object, not: { ...object, required: ["child"], properties: { child: requiresBad } } };
  assert.equal(partial(nested, { child: {} }).valid, true);
  assert.equal(partial(nested, { child: { bad: true } }).valid, false);
  const double = { ...object, not: { ...object, not: requiresBad } };
  assert.equal(partial(double, {}).valid, false);
  assert.equal(partial(double, { bad: true }).valid, true);
});

test("negative cardinality and optional predicates are evaluated, never universally deferred", () => {
  const cardinality = { ...object, not: { ...object, minProperties: 2 } };
  assert.equal(partial(cardinality, {}).valid, true);
  assert.equal(partial(cardinality, { a: 1, b: 2 }).valid, false);
  const arrays = { type: "array", not: { type: "array", minItems: 2, items: { type: "number" } } };
  assert.equal(partial(arrays, []).valid, true);
  assert.equal(partial(arrays, [1, 2]).valid, false);
  const optional = { ...object, not: { ...object, properties: { bad: { type: "boolean" } } } };
  assert.equal(partial(optional, {}).valid, false);
});

test("negative defaults match native effective semantics without mutating schema or candidate", () => {
  const schema = { ...object, not: { ...object, required: ["bad"], properties: { bad: { type: "boolean", default: true } } } };
  const before = structuredClone(schema), value = {};
  assert.deepEqual(partial(schema, value), effective(schema, value));
  assert.equal(partial(schema, value).valid, false);
  assert.deepEqual(value, {}); assert.deepEqual(schema, before);
});

test("same schema and candidate memo facts remain mode-partitioned in either evaluation order", () => {
  const shared = { ...object, required: ["bad"] }, value = {};
  const positive = { ...object, anyOf: [shared] }, negated = { ...object, not: shared };
  for (const branches of [[positive, negated], [negated, positive]]) {
    const schema = { ...object, allOf: branches };
    assert.equal(partial(schema, value).valid, true);
    assert.equal(effective(schema, value).valid, false);
    assert.equal(partial(schema, value).valid, true);
    assert.deepEqual(value, {});
  }
});

test("shared negative predicate facts retain path-local diagnostics and stable order", () => {
  const shared = { ...object, not: requiresBad };
  const schema = { type: "object", properties: { first: shared, second: shared } };
  const value = { bad: true }, data = { first: value, second: value };
  const result = partial(schema, data);
  assert.deepEqual(result.errors.map(({ path, message }) => ({ path, message })), [
    { path: "$.first", message: "Value must not match the not schema" },
    { path: "$.second", message: "Value must not match the not schema" },
  ]);
  assert.deepEqual(partial(schema, data), result);
  assert.deepEqual(data, { first: { bad: true }, second: { bad: true } });
});
