import assert from "node:assert/strict";
import { test } from "node:test";
import * as types from "../dist/index.js";

const grant = () => ({ identity: { environment: "east", scopePath: [{ scopeId: "constructor", value: "雪,:" }] }, namespace: "/example", operations: ["read", "inspect"], layers: ["first", "last"], views: ["one", "two"], sensitive: false });
test("native authority schemas capture readonly principal/grant/request DTOs without authenticating objects", () => {
  const input = { principalId: "verified-by-host", roles: ["reader"], grants: [grant()], expiresAt: 100 };
  const result = types.trustedPrincipalSnapshotSchema.parse(input);
  input.roles.push("other"); input.grants[0].identity.scopePath[0].value = "changed";
  assert.deepEqual(result.roles, ["reader"]); assert.equal(result.grants[0].identity.scopePath[0].value, "雪,:");
  for (const value of [result, result.roles, result.grants, result.grants[0], result.grants[0].identity.scopePath[0]]) assert.ok(Object.isFrozen(value));
  assert.equal(Object.isFrozen(input), false);
  const request = { identity: grant().identity, namespace: "/example", path: "/example/flag", operation: "read", sensitive: false };
  assert.ok(types.authorizationRequestSchema.safeParse(request).success);
  assert.ok(types.configurationAuthorityAuditRecordSchema.safeParse({ principalId: result.principalId, request, phase: "denied" }).success);
  for (const value of [{}, Object.freeze({}), JSON.parse("{}")]) assert.equal(types.configurationAuthorityCapabilitySchema.safeParse(value).success, false);
  assert.ok(types.authorizationDecisionSchema.safeParse("allowed").success);
  for (const value of [true, { allowed: true }, Promise.resolve("allowed"), "allow"]) assert.equal(types.authorizationDecisionSchema.safeParse(value).success, false);
});
test("strict authority fields, caller descriptors and writer adapter shapes reject before getter execution", () => {
  let gets = 0;
  const input = { principalId: "host", roles: ["reader"], grants: [grant()] };
  Object.defineProperty(input.grants[0].identity.scopePath, "0", { get() { gets++; return {}; } });
  assert.equal(types.trustedPrincipalSnapshotSchema.safeParse(input).success, false); assert.equal(gets, 0);
  for (const invalid of [{ ...grant(), role: "admin" }, { ...grant(), namespace: "relative" }, { ...grant(), operations: ["remove"] }]) assert.equal(types.authorityGrantSchema.safeParse(invalid).success, false);
  const writer = { providerId: "provider", operation: { kind: "write-layer", layer: "mapped" }, flush: "required", failureSemantics: "unknown" };
  const parsed = types.configurationProviderWriteBindingSchema.parse(writer);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.operation));
  assert.equal(types.configurationProviderWriteBindingSchema.safeParse({ ...writer, actor: "untrusted" }).success, false);
  let calls = 0; const fn = () => { calls++; };
  assert.ok(types.configurationAuthorityControllerSchema.safeParse({ mint: fn, revoke: fn, replace: fn, forIdentity: fn, forSchemas: fn, forMutations: fn, forSessions: fn }).success);
  assert.equal(types.configurationAuthorityControllerSchema.safeParse({ mint: fn, revoke: fn, replace: fn, bindRoot: fn, forIdentity: fn, forSchemas: fn, forMutations: fn }).success, false);
  assert.ok(types.configurationHostAuthoritySchema.safeParse({ authorizeReadSync: fn, authorizeWrite: fn }).success);
  assert.equal(calls, 0); assert.equal(Object.isFrozen(fn), false);
});
