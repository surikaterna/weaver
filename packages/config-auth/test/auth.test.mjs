import { withAuth } from "../src";
import { defineWeaver, Layers } from "@weaver-conf/config-types";

// --- Test WeaverConfig and AuthConfig ---

const testConfig = defineWeaver([
  Layers.Static("core"),
  Layers.Static("app"),
  Layers.Static("module"),
  Layers.Static("integrator"),
  Layers.Static("tenant"),
  Layers.Static("user"),
  Layers.Static("device"),
  Layers.Ephemeral("session"),
]);

const testAuth = withAuth({
  weaverConfig: testConfig,
  visibilityRoles: {
    admin: new Set(["tenant-admin", "platform-ops", "support"]),
    platform: new Set(["platform-ops"]),
  },
  layerWritePolicies: [
    { layer: "core", allowedRoles: ["system"] },
    { layer: "app", allowedRoles: ["platform-ops", "system"] },
    { layer: "module", allowedRoles: ["system"] },
    { layer: "integrator", allowedRoles: ["platform-ops", "integrator"] },
    { layer: "tenant", allowedRoles: ["platform-ops", "tenant-admin"] },
    { layer: "user", allowedRoles: ["user", "platform-ops", "support"] },
    { layer: "device", allowedRoles: ["user"] },
    { layer: "session", allowedRoles: ["platform-ops", "support"] },
  ],
  dynamicScopeRoles: new Set(["scope-admin", "tenant-admin", "platform-ops"]),
  sessionLayer: "session",
  elevatedSessionMode: "god-mode",
});

// --- canRead tests ---

test("canRead: public visibility allows all roles", () => {
  const ctx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canRead(ctx, "example.app.theme", { type: "string", "x-weaver": { visibility: "public" } })).toBe(true);
});

test("canRead: no schema allows read", () => {
  const ctx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canRead(ctx, "example.app.theme", undefined)).toBe(true);
});

test("canRead: missing visibility defaults to public", () => {
  const ctx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canRead(ctx, "example.app.theme", { type: "string" })).toBe(true);
});

test("canRead: admin visibility requires admin+ roles", () => {
  const adminCtx = { userId: "u1", tenantId: "t1", roles: ["tenant-admin"] };
  const userCtx = { userId: "u2", tenantId: "t1", roles: ["user"] };
  const opsCtx = { userId: "u3", tenantId: "t1", roles: ["platform-ops"] };
  const supportCtx = { userId: "u4", tenantId: "t1", roles: ["support"] };

  const schema = { type: "string", "x-weaver": { visibility: "admin" } };
  expect(testAuth.canRead(adminCtx, "k", schema)).toBe(true);
  expect(testAuth.canRead(opsCtx, "k", schema)).toBe(true);
  expect(testAuth.canRead(supportCtx, "k", schema)).toBe(true);
  expect(testAuth.canRead(userCtx, "k", schema)).toBe(false);
});

test("canRead: platform visibility requires platform-ops", () => {
  const opsCtx = { userId: "u1", tenantId: "t1", roles: ["platform-ops"] };
  const adminCtx = { userId: "u2", tenantId: "t1", roles: ["tenant-admin"] };
  const schema = { type: "string", "x-weaver": { visibility: "platform" } };
  expect(testAuth.canRead(opsCtx, "k", schema)).toBe(true);
  expect(testAuth.canRead(adminCtx, "k", schema)).toBe(false);
});

test("canRead: internal visibility denies all", () => {
  const opsCtx = { userId: "u1", tenantId: "t1", roles: ["platform-ops"] };
  const schema = { type: "string", "x-weaver": { visibility: "internal" } };
  expect(testAuth.canRead(opsCtx, "k", schema)).toBe(false);
});

// --- canWrite tests ---

test("canWrite: respects layer write policies", () => {
  // core layer only allows "system"
  const systemCtx = { userId: "u1", tenantId: "t1", roles: ["system"] };
  const userCtx = { userId: "u2", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canWrite(systemCtx, "core", "k", undefined)).toBe(true);
  expect(testAuth.canWrite(userCtx, "core", "k", undefined)).toBe(false);
});

test("canWrite: user can write to user layer", () => {
  const userCtx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canWrite(userCtx, "user", "k", undefined)).toBe(true);
});

test("canWrite: respects key writeRestriction", () => {
  const adminCtx = { userId: "u1", tenantId: "t1", roles: ["tenant-admin"] };
  const userCtx = { userId: "u2", tenantId: "t1", roles: ["user"] };
  const schema = {
    type: "string",
    "x-weaver": { writeRestriction: ["platform-ops"] },
  };
  // tenant-admin can write to tenant layer, but writeRestriction blocks them
  expect(testAuth.canWrite(adminCtx, "tenant", "k", schema)).toBe(false);
  // user can't even write to tenant layer
  expect(testAuth.canWrite(userCtx, "tenant", "k", schema)).toBe(false);
});

test("canWrite: respects maxOverrideLayer ceiling", () => {
  const userCtx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  const schema = {
    type: "number",
    "x-weaver": { maxOverrideLayer: "tenant" },
  };
  // user layer is above tenant, should be denied
  expect(testAuth.canWrite(userCtx, "user", "k", schema)).toBe(false);
});

test("canWrite: emergency override bypasses ceiling", () => {
  const userCtx = {
    userId: "u1",
    tenantId: "t1",
    roles: ["user"],
    sessionMode: "emergency-override",
  };
  const schema = {
    type: "number",
    "x-weaver": { maxOverrideLayer: "tenant" },
  };
  // emergency override should bypass the ceiling
  expect(testAuth.canWrite(userCtx, "user", "k", schema)).toBe(true);
});

test("canWrite: dynamic scope layers allow scope-admin", () => {
  const scopeAdminCtx = { userId: "u1", tenantId: "t1", roles: ["scope-admin"] };
  expect(testAuth.canWrite(scopeAdminCtx, "country:NO", "k", undefined)).toBe(true);
});

test("canWrite: dynamic scope layers deny regular user", () => {
  const userCtx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canWrite(userCtx, "country:NO", "k", undefined)).toBe(false);
});

// --- filterVisibleKeys tests ---

test("filterVisibleKeys: returns only readable keys", () => {
  const ctx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  const entries = {
    "example.app.theme": "dark",
    "example.app.secret": "hidden",
    "example.app.visible": true,
  };
  const schemaMap = new Map([
    ["example.app.theme", { type: "string", "x-weaver": { visibility: "public" } }],
    ["example.app.secret", { type: "string", "x-weaver": { visibility: "internal" } }],
    ["example.app.visible", { type: "boolean", "x-weaver": { visibility: "public" } }],
  ]);

  const result = testAuth.filterVisibleKeys(ctx, entries, schemaMap);
  expect("example.app.theme" in result).toBeTruthy();
  expect(!("example.app.secret" in result)).toBeTruthy();
  expect("example.app.visible" in result).toBeTruthy();
  expect(Object.keys(result).length).toBe(2);
});

test("filterVisibleKeys: keys without schema are visible", () => {
  const ctx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  const entries = { "example.app.unknown": "value" };
  const schemaMap = new Map();

  const result = testAuth.filterVisibleKeys(ctx, entries, schemaMap);
  expect("example.app.unknown" in result).toBeTruthy();
});

// --- session-mode tests (moved from config-engine) ---

// Helpers — session layer requires platform-ops or support role
const sessionCtx = (overrides = {}) => ({
  userId: "u1",
  tenantId: "t1",
  roles: ["platform-ops"],
  ...overrides,
});

const godModeCtx = (overrides = {}) => ({
  userId: "u1",
  tenantId: "t1",
  roles: ["platform-ops"],
  sessionMode: "god-mode",
  ...overrides,
});

test("session-mode: allowed (explicit) permits session layer write", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "allowed" } };
  expect(testAuth.canWrite(sessionCtx(), "session", "example.app.theme", schema)).toBe(true);
});

test("session-mode: undefined (default) permits session layer write", () => {
  const schema = { type: "string" };
  expect(testAuth.canWrite(sessionCtx(), "session", "example.app.theme", schema)).toBe(true);
});

test("session-mode: no schema permits session layer write", () => {
  expect(testAuth.canWrite(sessionCtx(), "session", "example.app.theme", undefined)).toBe(true);
});

test("session-mode: blocked rejects session layer write unconditionally", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "blocked" } };
  expect(testAuth.canWrite(sessionCtx(), "session", "example.app.theme", schema)).toBe(false);
});

test("session-mode: blocked rejects even with god-mode", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "blocked" } };
  expect(testAuth.canWrite(godModeCtx(), "session", "example.app.theme", schema)).toBe(false);
});

test("session-mode: restricted rejects session write without god-mode", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "restricted" } };
  expect(testAuth.canWrite(sessionCtx(), "session", "example.app.theme", schema)).toBe(false);
});

test("session-mode: restricted allows session write with god-mode", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "restricted" } };
  expect(testAuth.canWrite(godModeCtx(), "session", "example.app.theme", schema)).toBe(true);
});

test("session-mode: restricted rejects with non-god-mode session type", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "restricted" } };
  const ctx = sessionCtx({ sessionMode: "debug" });
  expect(testAuth.canWrite(ctx, "session", "example.app.theme", schema)).toBe(false);
});

test("session-mode: blocked key can still be written to tenant layer", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "blocked" } };
  const ctx = { userId: "u1", tenantId: "t1", roles: ["tenant-admin"] };
  expect(testAuth.canWrite(ctx, "tenant", "example.app.theme", schema)).toBe(true);
});

test("session-mode: restricted key can be written to user layer without god-mode", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "restricted" } };
  const ctx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canWrite(ctx, "user", "example.app.theme", schema)).toBe(true);
});

test("session-mode: existing layer policy still works", () => {
  const systemCtx = { userId: "u1", tenantId: "t1", roles: ["system"] };
  const userCtx = { userId: "u2", tenantId: "t1", roles: ["user"] };
  expect(testAuth.canWrite(systemCtx, "core", "k", undefined)).toBe(true);
  expect(testAuth.canWrite(userCtx, "core", "k", undefined)).toBe(false);
});

test("session-mode: writeRestriction still works at session layer", () => {
  const ctx = sessionCtx();
  const schema = { type: "string", "x-weaver": { writeRestriction: ["tenant-admin"] } };
  // platform-ops has session layer access but not writeRestriction role
  expect(testAuth.canWrite(ctx, "session", "k", schema)).toBe(false);
});

test("session-mode: maxOverrideLayer still works", () => {
  const userCtx = { userId: "u1", tenantId: "t1", roles: ["user"] };
  const schema = { type: "number", "x-weaver": { maxOverrideLayer: "tenant" } };
  expect(testAuth.canWrite(userCtx, "user", "k", schema)).toBe(false);
});
