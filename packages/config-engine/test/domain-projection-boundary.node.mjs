import assert from "node:assert/strict";
import { test } from "node:test";
import * as types from "@weaver-conf/config-types";
import * as engine from "../dist/index.js";
import { exerciseDomainBoundaries } from "../../config-types/test/domain-boundary-fixture.mjs";

test("real public domain schemas and engine routes preserve cold/warm zero-accessor semantics", () => {
  assert.deepEqual(exerciseDomainBoundaries(types, engine), { cases: 27, counterScopes: 6, callbacks: 0 });
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

test("zero-counter probes detect unsafe append controls and reject non-string coercion", () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "0");
  let getters = 0, setters = 0;
  try {
    Object.defineProperty(Object.prototype, "0", { configurable: true, get() { getters++; return "ambient"; }, set() { setters++; } });
    const unsafe = []; unsafe.push("control");
  } finally { if (original) Object.defineProperty(Object.prototype, "0", original); else Reflect.deleteProperty(Object.prototype, "0"); }
  assert.equal(setters, 1);
  let coercions = 0;
  const bad = { get length() { coercions++; return 1; }, get startsWith() { coercions++; return () => true; }, toString() { coercions++; return "bad"; } };
  for (const invoke of [() => engine.parseCanonicalConfigPath(bad), () => engine.canonicalConfigPathFromSegments([bad]),
    () => engine.canonicalConfigPathFromStorageKey(bad)]) assert.throws(invoke, { code: "VALIDATION_ERROR" });
  assert.equal(coercions, 0);
});
