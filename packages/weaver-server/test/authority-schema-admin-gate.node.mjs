import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createAuthGate, authGateOptionsSchema, authGateSchema } from "../src/transport/auth-gate.ts";
import { adminDenied } from "../src/transport/rest-schema-admin-gate.ts";
import { startWeaverServer } from "../src/server.ts";

const context = (roles = ["operator"]) => ({ userId: "verified", roles });
const options = (extra = {}) => ({
  authFunctions: { canRead: () => true, canWrite: () => false, filterVisibleKeys: (_ctx, entries) => entries },
  mapContext: (auth) => context(auth.identity.roles), schemaAdminRoles: ["operator"], ...extra,
});
const request = (roles = ["operator"], isAdmin = true) => ({
  params: {}, query: {}, headers: {}, authContext: { identity: { roles, claims: {} }, isAdmin, isService: false, isUser: true },
});
const deps = (authGate) => ({ authGate, configService: { revision: "unchanged" } });

test("schema purpose requires configured roles independently of configuration-write policy", () => {
  const roles = ["operator"], supplied = options({ schemaAdminRoles: roles });
  const gate = createAuthGate(supplied);
  roles.splice(0, 1, "unprivileged");
  assert.equal(authGateOptionsSchema.safeParse(options()).success, true);
  assert.equal(authGateSchema.safeParse(gate).success, true);
  assert.equal(gate.gateSchemaWrite(context()), null);
  assert.equal(gate.gateWrite(context(), "actual-layer", "key").status, 403);
  assert.equal(gate.gateSchemaWrite(context(["unprivileged"])).status, 403);
  const separateDenial = createAuthGate(options({
    authFunctions: { ...options().authFunctions, canWrite: () => true }, canRegisterSchema: () => false,
  }));
  assert.equal(separateDenial.gateWrite(context(), "actual-layer", "key"), null);
  assert.equal(separateDenial.gateSchemaWrite(context()).status, 403);
  for (const schemaAdminRoles of [undefined, [], null, [1]])
    assert.equal(createAuthGate(options({ schemaAdminRoles })).gateSchemaWrite(context()).status, 403);
});

test("synchronous schema callback only narrows and rejects throws/promises/thenables/malformed decisions", async () => {
  let calls = 0;
  const narrow = createAuthGate(options({ canRegisterSchema: () => { calls++; return true; } }));
  assert.equal(narrow.gateSchemaWrite(context([])).status, 403);
  assert.equal(calls, 0);
  assert.equal(narrow.gateSchemaWrite(context()), null);
  assert.equal(calls, 1);
  for (const canRegisterSchema of [
    () => false, () => undefined, () => 1, () => "allowed", () => ({ allowed: true }),
    () => { throw Error("PRIVATE"); }, () => Promise.resolve(true), () => Promise.reject(Error("PRIVATE")),
    () => ({ then(_resolve, reject) { reject(Error("PRIVATE")); } }),
  ]) {
    const denied = createAuthGate(options({ canRegisterSchema })).gateSchemaWrite(context());
    assert.equal(denied.status, 403); assert.doesNotMatch(JSON.stringify(denied), /PRIVATE/);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("route requires identity plus isAdmin, leaves schema-read policy separate, and fails closed for missing/broken write method", async () => {
  const gate = createAuthGate(options());
  assert.equal(adminDenied({ params: {}, query: {}, headers: {} }, deps(gate), "write").status, 401);
  assert.equal(adminDenied(request(["operator"], false), deps(gate), "write").status, 403);
  assert.equal(adminDenied(request([], true), deps(gate), "write").status, 403);
  assert.equal(adminDenied(request(), deps(gate), "write"), null);
  assert.equal(adminDenied(request([], true), deps(gate), "read"), null);
  const deniedRead = createAuthGate(options({ authFunctions: { ...options().authFunctions, canRead: () => false } }));
  assert.equal(adminDenied(request(), deps(deniedRead), "read").status, 403);
  for (const gateSchemaWrite of [undefined, 7, () => true, () => undefined, () => Promise.resolve(null), () => Promise.reject(Error("PRIVATE")), () => { throw Error("PRIVATE"); }]) {
    const result = adminDenied(request(), deps({ ...gate, gateSchemaWrite }), "write");
    assert.equal(result.status, 403); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.equal(adminDenied({}, deps(undefined), "write"), null, "explicit no-auth legacy composition is unchanged");
  await new Promise((resolve) => setImmediate(resolve));
});

function token(secret, claims) {
  const data = [ { alg: "HS256", typ: "JWT" }, { ...claims, exp: Math.floor(Date.now() / 1000) + 60 } ].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
const registration = { serviceId: "checkout", environment: "development", owner: { name: "owner", contact: "owner@example.org" },
  schema: { type: "object", properties: { enabled: { type: "boolean" } } }, fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }] };

test("real JWT registration preserves 401/403/201, custom roles and service-token role intersection for service and fragment writes", async () => {
  const secret = "bounded-schema-admin", provider = createInMemoryStorageProvider({ id: "disk", layer: "platform" });
  let writes = 0;
  const original = provider.write.bind(provider);
  provider.write = (...args) => { writes++; return original(...args); };
  const server = await startWeaverServer({ port: 0, jwtSecret: secret, adminRoles: ["operator"], providers: [provider] });
  const post = async (body, authorization, endpoint = "services") => {
    const response = await fetch(`http://localhost:${server.port}/v1/admin/schemas/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) }, body: JSON.stringify(body),
    });
    await response.json(); return response.status;
  };
  try {
    const baseline = writes;
    for (const [claims, expected] of [[undefined, 401], ["invalid", 401], [{ sub: "reader", roles: ["reader"] }, 403], [{ sub: "old-admin", roles: ["admin"] }, 403], [{ serviceId: "service", roles: [] }, 403]]) {
      const jwt = typeof claims === "object" ? token(secret, claims) : claims;
      assert.equal(await post(registration, jwt), expected);
    }
    assert.equal(writes, baseline);
    const admin = token(secret, { sub: "operator", roles: ["operator"] });
    assert.equal(await post(registration, admin), 201);
    const fragment = { serviceId: "checkout", environment: "development", providerId: "payment", slotPath: "/plugins", owner: registration.owner, schema: { type: "object" } };
    const beforeFragment = writes;
    assert.equal(await post(fragment, token(secret, { serviceId: "unprivileged" }), "fragments"), 403);
    assert.equal(writes, beforeFragment);
    assert.equal(await post(fragment, token(secret, { serviceId: "approved-service", roles: ["operator"] }), "fragments"), 201);
    assert.ok(writes > baseline);
  } finally { await server.close(); }
});
