import { createTestService } from "../setup-service.ts";
import { createRestAdapter } from "../../src/transport/rest-adapter.ts";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";

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
  const svc = await createTestService({ providers: [provider], environment: "dev" }, {
    app: { type: "object", additionalProperties: true },
    db: { type: "object", additionalProperties: true },
    new: { type: "object", additionalProperties: true },
  });
  const adapter = createRestAdapter({ configService: svc, ...opts });
  return { svc, adapter };
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
  test("GET /v1/config returns snapshot in envelope", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/config", req());
    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    assertV1Headers(res);
    expect(res.body.data.entries.app.name).toBe("test");
  });

  test("GET /v1/config with unprovisioned ?scope= rejects instead of inheriting base", async () => {
    const { adapter } = await setup();
    const res = await adapter.handleRequest("GET", "/v1/config", req({ query: { scope: "tenant:acme" } }));
    expect(res.status).toBe(404);
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
