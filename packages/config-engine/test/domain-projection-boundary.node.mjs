import assert from "node:assert/strict";
import { test } from "node:test";
import * as types from "@weaver-conf/config-types";
import * as engine from "../dist/index.js";
import { exerciseDomainBoundaries } from "../../config-types/test/domain-boundary-fixture.mjs";

test("real public domain schemas validate ordinary data without executing callables", () => {
  assert.deepEqual(exerciseDomainBoundaries(types, engine), { cases: 27, callbacks: 0 });
});
test("identity and DTO captures are detached, frozen, strict and descriptor-first", () => {
  let getters = 0;
  const identity = { environment: "test", scopePath: [{ scopeId: "tenant", value: "a" }] };
  const result = types.configurationServiceIdentitySchema.parse(identity);
  identity.scopePath[0].value = "changed";
  assert.equal(result.scopePath[0].value, "a");
  assert.ok(Object.isFrozen(result.scopePath[0]));
  assert.equal(Object.isFrozen(identity.scopePath[0]), false);
  const hidden = { environment: "test", scopePath: [] };
  Object.defineProperty(hidden, "hidden", { get() { getters++; return "payload"; } });
  assert.equal(types.configurationServiceIdentitySchema.safeParse(hidden).success, false);
  assert.equal(types.configurationInspectionValueSchema.safeParse({ state: "value", value: { get data() { getters++; return "payload"; } } }).success, false);
  assert.equal(getters, 0);
  const shared = { public: "yes" };
  const value = types.configurationInspectionValueSchema.parse({ state: "value", value: { left: shared, right: shared } });
  assert.equal(value.value.left, value.value.right);
  assert.notEqual(value.value.left, shared);
});

test("non-string paths reject before caller coercion", () => {
  let coercions = 0;
  const bad = { get length() { coercions++; return 1; }, get startsWith() { coercions++; return () => true; }, toString() { coercions++; return "bad"; } };
  for (const invoke of [() => engine.parseCanonicalConfigPath(bad), () => engine.canonicalConfigPathFromSegments([bad]),
    () => engine.canonicalConfigPathFromStorageKey(bad)]) assert.throws(invoke, { code: "VALIDATION_ERROR" });
  assert.equal(coercions, 0);
});
