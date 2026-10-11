import assert from "node:assert/strict";
import { test } from "node:test";
import * as types from "../dist/index.js";

const identity = { environment: "test", scopePath: [{ scopeId: "tenant", value: "snow:雪" }] };
const activation = { identity, namespace: "/example", reason: "incident", emergency: false, durationMs: 100 };
const sessionId = "f3ce6aac-1a75-49f9-a8ec-eed13f2e64a9";

test("native session DTOs capture identity and forbid caller authority/payload escape", () => {
  const input = structuredClone(activation), parsed = types.configurationSessionActivationSchema.parse(input);
  input.identity.scopePath[0].value = "mutated";
  assert.equal(parsed.identity.scopePath[0].value, "snow:雪");
  assert.ok(Object.isFrozen(parsed.identity.scopePath));
  for (const field of ["activatedBy", "actor", "mode", "elevatedAuth", "token", "sessionId"])
    assert.equal(types.configurationSessionActivationSchema.safeParse({ ...activation, [field]: "spoof" }).success, false, field);
  for (const durationMs of [0, -1, Infinity, NaN, 0.5, 2147483648])
    assert.equal(types.configurationSessionActivationSchema.safeParse({ ...activation, durationMs }).success, false);
  let getters = 0;
  assert.equal(types.configurationSessionActivationSchema.safeParse({ ...activation, get reason() { getters++; return "spy"; } }).success, false);
  assert.equal(getters, 0);
  const info = { identity, namespace: "/example", id: sessionId, layer: "incident", activatedBy: "verified", reason: "incident", emergency: false, activatedAt: 1000, expiresAt: 1100, followUpDeadline: 86401000 };
  assert.ok(types.configurationSessionInfoSchema.safeParse(info).success);
  for (const field of ["overrides", "provider", "capability", "grants"])
    assert.equal(types.configurationSessionInfoSchema.safeParse({ ...info, [field]: {} }).success, false);
});

test("lifecycle request discriminants require selectors only for existing sessions and expose no schema privilege", () => {
  const common = { identity, namespace: "/example", layer: "incident", reason: "incident", emergency: false };
  assert.ok(types.authorizationRequestSchema.safeParse({ ...common, operation: "session-activate", durationMs: 100 }).success);
  for (const operation of ["session-read", "session-extend", "session-deactivate"]) {
    assert.equal(types.authorizationRequestSchema.safeParse({ ...common, operation }).success, false);
    assert.ok(types.authorizationRequestSchema.safeParse({ ...common, operation, sessionId }).success);
  }
  assert.equal(types.authorizationRequestSchema.safeParse({ ...common, operation: "session-read", sessionId, durationMs: 100 }).success, false);
  const claims = types.trustedPrincipalSnapshotSchema.parse({ principalId: "host", roles: [], grants: [], sessionPermissions: ["read", "activate", "manage"] });
  assert.ok(Object.isFrozen(claims.sessionPermissions)); assert.equal(claims.schemaPermissions, undefined);
  assert.equal(types.trustedPrincipalSnapshotSchema.safeParse({ ...claims, session: { mode: "god-mode", overrideReason: "spoof" } }).success, false);
  let calls = 0; const fn = () => { calls++; };
  assert.ok(types.configurationSessionAuthoritySchema.safeParse({ activate: fn, extend: fn, deactivate: fn, get: fn, list: fn }).success);
  assert.equal(calls, 0);
});
