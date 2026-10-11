import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createRestAdapter } from "../../src/transport/rest-adapter.ts";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";
import { registerTestService, registerTestSchema } from "../fixtures/schema-authority.mjs";
import { weaverErrorSchema } from "@weaver-conf/config-types";

function createTestProvider(id, layer, entries, writable = true) {
  let data = JSON.parse(JSON.stringify(entries));
  return {
    id,
    layer,
    writable,
    async load() { return { entries: JSON.parse(JSON.stringify(data)) }; },
    async write(key, value) {
      deepSet(data, key, value);
      return { success: true };
    },
    async remove(key) {
      deepRemove(data, key);
      return { success: true };
    },
  };
}

async function setup(opts = {}) {
  const provider = createTestProvider("p1", "platform", { app: { name: "test" }, db: { host: "localhost" } });
  const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
  const registry = await registerTestService(svc, "app", "dev", { name: { type: "string" } });
  await registerTestSchema(registry, "db", "dev", {
    host: { type: "string" }, port: { type: "integer" },
  });
  await registerTestSchema(registry, "new", "dev", { key: { type: "integer" } });
  const adapter = createRestAdapter({ configService: svc, schemaRegistry: registry, ...opts });
  return { svc, adapter, provider, registry };
}

function req(overrides = {}) {
  return { params: {}, query: {}, headers: {}, ...overrides };
}

function assertEnvelope(body) {
  expect(body.data !== undefined).toBeTruthy();
  expect(body.meta).toBeTruthy();
  expect(body.meta.revision).toBeTruthy();
  expect(body.meta.timestamp).toBeTruthy();
}

function assertETag(res) {
  expect(res.headers?.["ETag"]).toBeTruthy();
  expect(res.headers["ETag"].startsWith('"')).toBeTruthy();
}

function assertCacheControl(res) {
  expect(res.headers?.["Cache-Control"]).toBe("no-cache");
}

function assertV1Headers(res) {
  assertETag(res);
  assertCacheControl(res);
  expect(res.headers["Content-Type"]).toBe("application/json");
}

describe("RestAdapter v1", () => {
  test("authorization precedes schema denial on every generic write route", async () => {
    const { svc, registry, provider } = await setup();
    const writes = vi.spyOn(provider, "write");
    const gate = {
      toAccessContext: () => ({}),
      gateWrite: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Denied" } }, headers: {} }),
    };
    const adapter = createRestAdapter({ configService: svc, schemaRegistry: registry, authGate: gate });
    const revision = svc.revision;
    for (const [method, path, body] of [
      ["PUT", "/v1/config/unknown/child", { value: "x" }],
      ["DELETE", "/v1/config/unknown/child", undefined],
      ["PATCH", "/v1/config", { entries: { "unknown.child": "x" } }],
    ]) {
      const response = await adapter.handleRequest(method, path, req({ body, authContext: { subject: "denied" } }));
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(JSON.stringify(response.body)).not.toContain("SCHEMA_NOT_REGISTERED");
    }
    expect(writes).not.toHaveBeenCalled();
    expect(svc.revision).toBe(revision);
  });

  test("authorized generic writes retain typed 400 errors and zero effects on complete denial", async () => {
    const { svc, adapter, provider, registry } = await setup();
    await registerTestSchema(registry, "open", "dev", { mode: { type: "string" } }, { additionalProperties: false });
    const writes = vi.spyOn(provider, "write");
    const removes = vi.spyOn(provider, "remove");
    const deltas = [];
    svc.onDelta((delta) => deltas.push(delta));
    const revision = svc.revision;
    for (const [method, path, body, code] of [
      ["PUT", "/v1/config/missing/key", { value: "x" }, "SCHEMA_NOT_REGISTERED"],
      ["DELETE", "/v1/config/open/rogue", undefined, "SCHEMA_NOT_REGISTERED"],
      ["PUT", "/v1/config/open", { value: { mode: "ok", rogue: { nested: 1 } } }, "SCHEMA_NOT_REGISTERED"],
      ["PATCH", "/v1/config", { entries: { "open.mode": "ok", "open.rogue": "x" } }, "SCHEMA_NOT_REGISTERED"],
      ["PUT", "/v1/config/open/mode", { value: 1 }, "VALIDATION_ERROR"],
    ]) {
      const response = await adapter.handleRequest(method, path, req({ body }));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(code);
      expect(weaverErrorSchema.safeParse(response.body.error).success).toBe(true);
      expect([writes.mock.calls.length, removes.mock.calls.length, deltas.length]).toEqual([0, 0, 0]);
      expect(svc.revision).toBe(revision);
    }
    expect((await provider.load()).entries.open).toBeUndefined();
  });
  test("GET /v1/config returns snapshot in envelope", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/config", req());
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    assertV1Headers(res);
    expect(res.body.data.entries.app.name).toBe("test");
  });

  test("GET /v1/config with ?scope= passes scope", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/config", req({ query: { scope: "tenant:acme" } }));
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
  });

  test("GET /v1/config/app/name returns value via path segments", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/config/app/name", req());
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    assertV1Headers(res);
    expect(res.body.data.key).toBe("app.name");
    expect(res.body.data.value).toBe("test");
  });

  test("GET /v1/config/app/name?inspect returns inspection", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/config/app/name", req({ query: { inspect: "" } }));
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.data.key).toBe("app.name");
    expect(res.body.data.layerValues).toBeTruthy();
  });

  test("PUT /v1/config/new/key sets value", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("PUT", "/v1/config/new/key", req({ body: { value: 42 }, query: { layer: "platform" } }));
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    assertV1Headers(res);
    expect(res.body.data.success).toBe(true);
  });

  test("legacy unregistered PUT returns a typed denial without effects", async () => {
    const { adapter, svc, provider } = await setup();
    const revision = svc.revision;
    const res = await adapter.handleRequest("PUT", "/v1/config/legacy/value", req({
      body: { value: "old-policy" },
    }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SCHEMA_NOT_REGISTERED");
    expect(svc.revision).toBe(revision);
    expect((await provider.load()).entries.legacy).toBeUndefined();
    expect(await svc.get("legacy.value")).toBeUndefined();
  });

  test("an unavailable server-bound registry is a 5xx write denial, not a missing declaration", async () => {
    const provider = createTestProvider("p1", "platform", { legacy: { value: "readable" } });
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const adapter = createRestAdapter({ configService: svc });
    const revision = svc.revision;
    const res = await adapter.handleRequest("PUT", "/v1/config/legacy/value", req({
      body: { value: "blocked" },
    }));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect((await provider.load()).entries.legacy).toEqual({ value: "readable" });
    expect(svc.revision).toBe(revision);
  });

  test("authorized PUT and PATCH reject a declared write when an invalid legacy sibling remains", async () => {
    const provider = createTestProvider("p1", "platform", { svc: { mode: "old", rogue: "legacy" } });
    const write = vi.spyOn(provider, "write");
    const remove = vi.spyOn(provider, "remove");
    const flush = vi.fn(async () => {});
    provider.dirty = true;
    provider.flush = flush;
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const registry = await registerTestService(svc, "svc", "dev", { mode: { type: "string" } });
    const adapter = createRestAdapter({ configService: svc, schemaRegistry: registry });
    const revision = svc.revision;
    const deltas = [];
    svc.onDelta((delta) => deltas.push(delta));
    const denied = [
      ["PUT", "/v1/config/svc/mode", { value: "new" }],
      ["PATCH", "/v1/config", { entries: { "svc.mode": "new" } }],
    ];
    for (const [method, path, body] of denied) {
      const response = await adapter.handleRequest(method, path, req({ body }));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect([write.mock.calls.length, remove.mock.calls.length, flush.mock.calls.length, deltas.length]).toEqual([0, 0, 0, 0]);
      expect(svc.revision).toBe(revision);
      expect((await provider.load()).entries.svc).toEqual({ mode: "old", rogue: "legacy" });
    }
    const replacement = await adapter.handleRequest("PUT", "/v1/config/svc", req({ body: { value: { mode: "clean" } } }));
    expect(replacement.status).toBe(200);
    expect((await provider.load()).entries.svc).toEqual({ mode: "clean" });
  });

  test("authorized generic array-index PUT, DELETE and mixed PATCH remain typed 400 with no effects", async () => {
    const { adapter, svc, provider, registry } = await setup();
    await registerTestSchema(registry, "arrays", "dev", { items: { type: "array", items: { type: "string" } } });
    expect((await svc.set("platform", "arrays", { items: ["old"] })).success).toBe(true);
    const revision = svc.revision;
    const persisted = (await provider.load()).entries;
    const cases = [
      ["PUT", "/v1/config/arrays/items/0", { body: { value: "bad" } }],
      ["DELETE", "/v1/config/arrays/items/0", {}],
      ["PATCH", "/v1/config", { body: { entries: { "app.name": "new", "arrays.items[0]": "bad" } } }],
    ];
    for (const [method, path, input] of cases) {
      const res = await adapter.handleRequest(method, path, req(input));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("UNSUPPORTED_OPERATION");
      expect(svc.revision).toBe(revision);
      expect((await provider.load()).entries).toEqual(persisted);
    }
  });

  test("PUT /v1/config/new/key defaults layer to platform", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("PUT", "/v1/config/new/key", req({ body: { value: 42 } }));
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
  });

  test("DELETE /v1/config/app/name removes value", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("DELETE", "/v1/config/app/name", req({ query: { layer: "platform" } }));
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    assertV1Headers(res);
    expect(res.body.data.success).toBe(true);
  });

  test("GET /v1/config/db returns subtree as value", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/config/db", req());
    expect(res.status).toBe(200);
    expect(res.body.data.key).toBe("db");
    expect(res.body.data.value).toEqual({ host: "localhost" });
  });

  test("404 for unknown routes has envelope", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/api/unknown", req());
    expect(res.status).toBe(404);
    assertEnvelope(res.body);
    expect(res.body.data).toBe(null);
    expect(res.body.error).toBeTruthy();
    assertV1Headers(res);
  });

  test("error responses use envelope with error field", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("PUT", "/v1/config/key", req({ body: { value: 1 }, query: { layer: "nope" } }));
    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect(res.body.error).toBeTruthy();
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("CORS headers when configured", async () => {
    const { adapter } = await setup({ corsOrigins: ["http://localhost:3000"] });
    const res = await adapter.handleRequest(
      "GET",
      "/v1/config",
      req({ headers: { origin: "http://localhost:3000" } }),
    );
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:3000",
    );
  });

  test("OPTIONS responds with CORS headers", async () => {
    const { adapter } = await setup({ corsOrigins: ["*"] });
    const res = await adapter.handleRequest(
      "OPTIONS",
      "/v1/config",
      req({
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-headers": "Authorization, Content-Type",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Access-Control-Allow-Headers"]).toBe(
      "Authorization, Content-Type",
    );
  });

  test("scope routes return envelope", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/scopes", req());
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    assertV1Headers(res);
  });

  test("ETag header present on all responses", async () => {
    const { adapter } = await setup();
    const endpoints = [
      ["GET", "/v1/config"],
      ["GET", "/v1/config/app/name"],
      ["GET", "/v1/scopes"],
    ];
    for (const [method, path] of endpoints) {
      const res = await adapter.handleRequest(method, path, req());
      assertETag(res);
    }
  });

  test("PATCH /v1/config writes multiple entries", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("PATCH", "/v1/config", req({
      body: { entries: { "db.host": "newhost", "db.port": 5432 } },
    }));
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.written).toBe(2);
  });

  test("PATCH /v1/config returns 400 when entries missing", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("PATCH", "/v1/config", req({
      body: {},
    }));
    expect(res.status).toBe(400);
  });
});
