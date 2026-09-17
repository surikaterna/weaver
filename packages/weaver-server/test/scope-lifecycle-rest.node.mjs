import assert from "node:assert/strict";
import { test } from "node:test";
import { withAuth } from "@weaver-conf/config-auth";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createScopeManager } from "../src/core/scope-manager.ts";
import { createAuthGate } from "../src/transport/auth-gate.ts";
import { createRestAdapter } from "../src/transport/rest-adapter.ts";
import { initialized, record } from "./validated-fixtures.mjs";

const scopePath = [{ scopeId: "tenant", value: "cold" }];
const schema = {
  type: "object",
  required: ["n"],
  properties: { n: { type: "number" } },
  additionalProperties: false,
};

function identity(role, isService = false) {
  return {
    identity: { userId: role, roles: [role], claims: {} },
    isAdmin: role === "admin",
    isService,
    isUser: !isService,
  };
}

function request(authContext = identity("admin"), revision) {
  return {
    params: {},
    query: {},
    headers: revision === undefined ? {} : { "if-match": `"${revision}"` },
    ...(authContext ? { authContext } : {}),
    body: { value: "cold" },
  };
}

function gate(service, explicitPolicy) {
  return createAuthGate({
    authFunctions: withAuth({
      weaverConfig: service.layout,
      visibilityRoles: { admin: new Set(["admin"]) },
      layerWritePolicies: explicitPolicy
        ? [{ layer: "admin", allowedRoles: ["admin"] }]
        : [],
      dynamicScopeRoles: new Set(["admin", "reader"]),
    }),
    mapContext: (context) => ({
      userId: context.identity.userId,
      roles: context.identity.roles,
    }),
  });
}

async function fixture(t, state = "retired", explicitPolicy = false) {
  const f = await initialized({
    records: [record("svc", schema)],
    data: { svc: { n: 1 } },
    scopes: [{ id: "tenant", label: "Tenant" }],
    contexts: [{ scopePath, state }],
    scoped: { "tenant:cold": { svc: { n: 2 } } },
  });
  t.after(() => f.service.close());
  const scopeManager = createScopeManager({ configService: f.service });
  const authGate = gate(f.service, explicitPolicy);
  const adapter = createRestAdapter({
    configService: f.service,
    scopeManager,
    authGate,
  });
  return { ...f, scopeManager, authGate, adapter };
}

for (const explicitPolicy of [false, true]) {
  test(`fteq REST: denies before parsing or effects, explicit policy=${explicitPolicy}`, async (t) => {
    const f = await fixture(t, "retired", explicitPolicy);
    const before = await f.platform.load();
    const revision = f.service.revision;
    const provision = t.mock.method(f.scopeManager, "provision");
    const deprovision = t.mock.method(f.scopeManager, "deprovision");
    const gateWrite = t.mock.method(f.authGate, "gateWrite");
    const adapters = [
      f.adapter,
      createRestAdapter({ configService: f.service, authGate: f.authGate }),
    ];
    for (const adapter of adapters) {
      for (const auth of [null, identity("reader"), identity("reader", true)]) {
        for (const method of ["POST", "DELETE"]) {
          const path = `/v1/admin/scopes/tenant${method === "DELETE" ? "/cold" : ""}`;
          const response = await adapter.handleRequest(method, path, {
            ...request(auth),
            body: {
              get value() {
                throw new Error("Denied body must not be parsed");
              },
            },
          });
          assert.equal(response.status, auth ? 403 : 401);
          assert.equal(response.body.error.code, auth ? "FORBIDDEN" : "UNAUTHORIZED");
        }
      }
    }
    assert.equal(provision.mock.callCount(), 0);
    assert.equal(deprovision.mock.callCount(), 0);
    assert.equal(gateWrite.mock.callCount(), 0);
    assert.equal(f.service.revision, revision);
    assert.deepEqual(await f.platform.load(), before);
  });
}

test("fteq REST: success, idempotence, stale CAS and restart agree with durable inventory", async (t) => {
  const f = await fixture(t);
  const revision = f.service.revision;
  const post = (rev) => f.adapter.handleRequest(
    "POST", "/v1/admin/scopes/tenant", request(identity("admin"), rev),
  );
  const del = (rev) => f.adapter.handleRequest(
    "DELETE", "/v1/admin/scopes/tenant/cold", request(identity("admin"), rev),
  );
  const activated = await post(revision);
  assert.equal(activated.status, 201);
  assert.equal(activated.body.data.inventoryRevision, "1");
  assert.equal(activated.body.data.revision, f.service.revision);
  assert.equal(await f.service.get("svc.n", { scopePath }), 2);
  const activeRevision = f.service.revision;
  const activeStore = await f.platform.load();
  assert.equal((await post(activeRevision)).body.data.inventoryRevision, "1");
  assert.equal(f.service.revision, activeRevision);
  const stale = await del(revision);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "REVISION_CONFLICT");
  assert.deepEqual(await f.platform.load(), activeStore);
  assert.deepEqual(f.scopeManager.listScopeValues("tenant"), ["cold"]);
  const retired = await del(activeRevision);
  assert.equal(retired.status, 200);
  assert.equal(retired.body.data.inventoryRevision, "2");
  await assert.rejects(f.service.get("svc.n", { scopePath }), { code: "SCOPE_NOT_FOUND" });
  await f.service.close();
  const restarted = await createWeaverConfigService({ providers: f.providers, environment: "dev" });
  t.after(() => restarted.close());
  assert.deepEqual(createScopeManager({ configService: restarted }).listScopeValues("tenant"), []);
  assert.equal((await f.platform.load()).entries._weaver.scopeInventory.revision, "2");
  assert.deepEqual((await f.providers[1].loadLayer("tenant:cold")).entries.svc, { n: 2 });
});

for (const state of ["active", "retired"]) {
  test(`fteq REST: failed ${state === "active" ? "retirement" : "activation"} has no inventory effects`, async (t) => {
    const f = await fixture(t, state);
    const before = await f.platform.load();
    const revision = f.service.revision;
    const events = [];
    f.service.onDelta((event) => events.push(event));
    t.mock.method(f.platform.authority, "commitLayer", async () => ({
      success: false,
      error: { code: "WRITE_ERROR", message: "Injected acknowledged rejection" },
    }));
    const response = await f.adapter.handleRequest(
      state === "active" ? "DELETE" : "POST",
      `/v1/admin/scopes/tenant${state === "active" ? "/cold" : ""}`,
      request(identity("admin"), revision),
    );
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "WRITE_ERROR");
    assert.equal(f.service.revision, revision);
    assert.deepEqual(await f.platform.load(), before);
    assert.deepEqual(f.scopeManager.listScopeValues("tenant"), state === "active" ? ["cold"] : []);
    assert.deepEqual(events, []);
  });
}

test("fteq REST: unprepared stores are refused without publishing an active context", async (t) => {
  const f = await fixture(t);
  const before = await f.platform.load();
  const revision = f.service.revision;
  const response = await f.adapter.handleRequest("POST", "/v1/admin/scopes/tenant", {
    ...request(identity("admin"), revision),
    body: { value: "not-prepared" },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "UNSUPPORTED_AUTHORITY");
  assert.equal(f.service.revision, revision);
  assert.deepEqual(await f.platform.load(), before);
  assert.deepEqual(f.scopeManager.listScopeValues("tenant"), []);
});

test("fteq REST: full-context lifecycle validates the route target and retires child-first", async (t) => {
  const child = [...scopePath, { scopeId: "region", value: "eu" }];
  const f = await initialized({ records: [record("svc", schema)], data: { svc: { n: 1 } },
    scopes: [{ id: "tenant", label: "Tenant" }, { id: "region", label: "Region", parentScopeId: "tenant" }],
    contexts: [{ scopePath, state: "active" }, { scopePath: child, state: "retired" }],
    scoped: { "tenant:cold": { svc: { n: 2 } }, "region:eu": { svc: { n: 3 } } } });
  t.after(() => f.service.close());
  const adapter = createRestAdapter({ configService: f.service,
    scopeManager: createScopeManager({ configService: f.service }), authGate: gate(f.service, true) });
  const query = { scope: "tenant:cold/region:eu" };
  const activated = await adapter.handleRequest("POST", "/v1/admin/scopes/region", {
    ...request(identity("admin"), f.service.revision), query, body: { value: "eu" },
  });
  assert.equal(activated.status, 201);
  assert.deepEqual(activated.body.data.scopePath, child);
  assert.equal(await f.service.get("svc.n", { scopePath: child }), 3);
  const before = await f.platform.load();
  const revision = f.service.revision;
  assert.equal((await adapter.handleRequest("DELETE", "/v1/admin/scopes/tenant/cold", request(identity("admin"), revision))).status, 400);
  assert.equal((await adapter.handleRequest("DELETE", "/v1/admin/scopes/region/wrong", { ...request(identity("admin"), revision), query })).status, 400);
  assert.equal(f.service.revision, revision);
  assert.deepEqual(await f.platform.load(), before);
  const retired = await adapter.handleRequest("DELETE", "/v1/admin/scopes/region/eu", { ...request(identity("admin"), revision), query });
  assert.equal(retired.status, 200);
  assert.deepEqual(retired.body.data.scopePath, child);
  await assert.rejects(f.service.get("svc.n", { scopePath: child }), { code: "SCOPE_NOT_FOUND" });
});
