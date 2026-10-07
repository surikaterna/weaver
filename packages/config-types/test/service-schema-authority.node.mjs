import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../dist/index.js";

test("native schema permissions are immutable, independent and strict", () => {
  const input = { principalId: "verified", roles: [], grants: [], schemaPermissions: ["read", "register"] };
  const captured = types.trustedPrincipalSnapshotSchema.parse(input);
  input.schemaPermissions.length = 0;
  assert.deepEqual(captured.schemaPermissions, ["read", "register"]);
  assert.ok(Object.isFrozen(captured.schemaPermissions));
  for (const schemaPermissions of [["admin"], ["write"], "read", ["schema-read"]])
    assert.equal(types.trustedPrincipalSnapshotSchema.safeParse({ ...input, schemaPermissions }).success, false);
  let gets = 0;
  const permissions = []; Object.defineProperty(permissions, "0", { enumerable: true, get() { gets++; return "read"; } });
  assert.equal(types.trustedPrincipalSnapshotSchema.safeParse({ ...input, schemaPermissions: permissions }).success, false);
  assert.equal(gets, 0);
});

test("schema authorization discriminants never masquerade as config paths or caller actors", () => {
  for (const request of [
    { operation: "schema-read", query: "snapshot" }, { operation: "schema-read", query: "list" },
    { operation: "schema-read", query: "get", anchorPath: "/alpha", environment: "east" },
    { operation: "schema-register", kind: "service", anchorPath: "/alpha", environment: "east" },
  ]) {
    assert.equal(types.authorizationRequestSchema.safeParse(request).success, true);
    assert.equal(types.configurationAuthorizationRequestSchema.safeParse(request).success, false);
    assert.equal(types.authorizationRequestSchema.safeParse({ ...request, actor: "root" }).success, false);
    assert.equal(types.configurationAuthorityAuditRecordSchema.safeParse({ principalId: "host", request, phase: "before-dispatch" }).success, true);
  }
  assert.equal(types.schemaOperationResultSchema.safeParse({ success: false, outcome: "unknown",
    error: types.createWeaverError("WRITE_OUTCOME_UNKNOWN", "Outcome unknown"), revision: "accepted" }).success, false);
  assert.equal(types.schemaOperationResultSchema.safeParse({ success: true, revision: "1", isNewSchema: true, hasBreakingChanges: false }).success, false);
});
