import assert from "node:assert/strict";
import { test } from "node:test";
import * as types from "../dist/index.js";

const selection = () => ({ identity: { environment: "east", scopePath: [{ scopeId: "a|雪", value: "b|é" }] }, namespace: "/example" });

test("captured reader schemas detach native data and enforce one selection dialect", () => {
  const input = selection();
  const captured = types.configurationReaderSelectionSchema.parse(input);
  input.identity.scopePath[0].value = "changed";
  assert.equal(captured.identity.scopePath[0].value, "b|é");
  assert.ok(Object.isFrozen(captured.identity.scopePath[0]));
  assert.deepEqual(types.relativeConfigurationPathSchema.parse([]), []);
  for (const viewId of ["literal.dot", "雪", "a|b", "*"])
    assert.equal(types.configurationReaderSelectionSchema.parse({ ...selection(), viewId }).viewId, viewId);
  for (const viewId of ["", "../escape", "..", "a/b", "constructor", "_weaver"])
    assert.equal(types.configurationReaderSelectionSchema.safeParse({ ...selection(), viewId }).success, false);
  assert.equal(types.configurationReaderSelectionSchema.safeParse({ ...selection(), namespace: "/", viewId: "one" }).success, false);
  assert.equal(types.configurationReaderSelectionSchema.safeParse({ ...selection(), namespace: "/example/instances/one" }).success, false);
  assert.equal(types.configurationReaderSelectionSchema.safeParse({ ...selection(), root: {} }).success, false);
});

test("reader schemas never invoke caller accessors or authenticate parsed handles", () => {
  let calls = 0;
  const input = selection();
  Object.defineProperty(input.identity.scopePath, "0", { get() { calls++; return {}; } });
  assert.equal(types.configurationReaderSelectionSchema.safeParse(input).success, false);
  assert.equal(calls, 0);
  const fn = () => { calls++; };
  const shape = { selection: selection(), revision: "r", prepare: fn, get: fn, snapshot: fn, inspect: fn, validate: fn, withScope: fn, forView: fn, onChange: fn, dispose: fn };
  assert.ok(types.configurationReaderSchema.safeParse(shape).success);
  assert.equal(types.configurationAuthorityCapabilitySchema.safeParse(shape).success, false);
  assert.equal(calls, 0);
  for (const alias of ["HydratedConfigurationReader", "hydratedConfigurationReaderSchema", "hydratedConfigurationServiceSchema", "configurationAuthorityRequestSchema"])
    assert.equal(types[alias], undefined);
});

test("root grants are explicit read-only base grants and write namespaces remain nonroot", () => {
  const grant = { identity: selection().identity, namespace: "/", operations: ["read", "inspect"], layers: ["base"], views: [], sensitive: false };
  assert.ok(types.authorityGrantSchema.safeParse(grant).success);
  assert.equal(types.authorityGrantSchema.safeParse({ ...grant, operations: ["write"] }).success, false);
  assert.equal(types.authorityGrantSchema.safeParse({ ...grant, views: ["view"] }).success, false);
  const request = { identity: grant.identity, namespace: "/", path: "/", sensitive: false };
  assert.ok(types.configurationAuthorizationRequestSchema.safeParse({ ...request, operation: "read" }).success);
  assert.equal(types.configurationAuthorizationRequestSchema.safeParse({ ...request, operation: "write", mutation: "set" }).success, false);
});
