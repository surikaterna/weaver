import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalSchemaRegistry } from "@weaver-conf/config-registry";
import { prepareConfigMutation, admissionContextSchema, mutationSchema, preparedMutationSchema } from "../dist/admission.js";
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
