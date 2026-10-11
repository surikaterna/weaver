import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalSchemaRegistry } from "@weaver-conf/config-registry";
import { prepareConfigMutation, admissionContextSchema, mutationSchema, preparedMutationSchema, buildSchemaPatch, schemaPatchResultSchema } from "../dist/admission.js";
import { registration } from "./fixtures/memory.mjs";

test("public shared admission preserves legacy batch, array and structural schema behavior", () => {
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  assert.equal(registry.register(registration()).success, true);
  const input = { registry, environment: "east", layerBefore: { alpha: { flag: "before", list: [1, 2], cfg: { a: 1 } } }, effectiveAfter: (entries) => entries,
    mutations: [{ operation: "set", key: "alpha.flag", value: "after" }, { operation: "set", key: "alpha.cfg.a", value: 2 }] };
  assert.equal(admissionContextSchema.safeParse(input).success, true);
  assert.equal(mutationSchema.safeParse(input.mutations[0]).success, true);
  const result = prepareConfigMutation(input);
  assert.equal(result.success, true); assert.equal(preparedMutationSchema.safeParse(result).success, true);
  assert.equal(result.layerAfter.alpha.flag, "after"); assert.equal(input.layerBefore.alpha.flag, "before");
  assert.equal(prepareConfigMutation({ ...input, mutations: [{ operation: "set", key: "alpha.list.0", value: 3 }] }).result.error.code, "UNSUPPORTED_OPERATION");
  assert.equal(prepareConfigMutation({ ...input, mutations: [{ operation: "set", key: "alpha.list", value: [3, 2], dedicated: true, admissionKey: "alpha.list.0", admissionValue: 3 }] }).success, true);
  assert.equal(prepareConfigMutation({ ...input, mutations: [{ operation: "set", key: "alpha.cfg", value: {} }, { operation: "set", key: "alpha.cfg.a", value: 3 }] }).success, false);
});
test("native admission DTO schemas reject caller getters without invoking them", () => {
  let getters = 0;
  assert.equal(mutationSchema.safeParse({ operation: "set", key: "alpha.flag", get value() { getters++; return "unsafe"; } }).success, false);
  assert.equal(admissionContextSchema.safeParse({ get registry() { getters++; return {}; } }).success, false);
  assert.equal(preparedMutationSchema.safeParse({ success: true, layerAfter: { get alpha() { getters++; return {}; } } }).success, false);
  assert.equal(getters, 0);
});

test("dedicated nullable patch admission uses logical null, never the physical anchor payload", () => {
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  const schema = { type: "object", properties: { value: { type: ["string", "null"] } } };
  assert.equal(registry.register({ ...registration(), schema }).success, true);
  const result = prepareConfigMutation({ registry, environment: "east", layerBefore: { alpha: { value: "old" } },
    effectiveAfter: (entries) => entries, mutations: [{ operation: "set", key: "alpha", value: { value: null },
      dedicated: true, admissionKey: "alpha.value", admissionValue: null }] });
  assert.equal(result.success, true);
  assert.equal(result.layerAfter.alpha.value, null);
});

test("shared value patch mechanics preserve arrays and infer only unambiguous canonical containers", () => {
  const item = { type: "object", properties: { value: { type: ["string", "null"] } } };
  const schema = { type: "object", properties: { list: { type: "array", items: item } } };
  const original = { list: [{ value: "old" }] };
  const patched = buildSchemaPatch(original, ["list", "1", "value"], null, schema);
  assert.ok(schemaPatchResultSchema.safeParse(patched).success);
  assert.deepEqual(patched, { success: true, value: { list: [{ value: "old" }, { value: null }] } });
  assert.deepEqual(original, { list: [{ value: "old" }] });
  assert.equal(buildSchemaPatch(original, ["list", "2", "value"], "hole", schema).reason, "array-index-out-of-range");
  assert.equal(buildSchemaPatch(original, ["list", "01"], "bad", schema).reason, "invalid-array-index");
  const numeric = { type: "object", properties: { "0": { type: "string" } } };
  assert.deepEqual(buildSchemaPatch({}, ["0"], "literal", numeric), { success: true, value: { "0": "literal" } });
  const open = { type: "object", additionalProperties: true };
  assert.equal(buildSchemaPatch({}, ["unknown", "0"], "ambiguous", open).reason, "invalid-container");
  assert.deepEqual(buildSchemaPatch({ known: [] }, ["known", "0"], null, open), { success: true, value: { known: [null] } });
});

test("shared patch preparation uses candidate-selected anyOf members instead of a second schema walker", () => {
  const schema = { type: "object", properties: { kind: { type: "string" } }, anyOf: [
    { type: "object", properties: { kind: { type: "string", const: "text" }, list: { type: "array", items: { type: "string" } } } },
    { type: "object", properties: { kind: { type: "string", const: "number" }, list: { type: "object", properties: { "0": { type: "number" } } } } },
  ] };
  assert.deepEqual(buildSchemaPatch({ kind: "text" }, ["list", "0"], "first", schema),
    { success: true, value: { kind: "text", list: ["first"] } });
});
