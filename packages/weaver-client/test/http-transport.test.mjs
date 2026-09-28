
const { createHttpTransport } = await import("../src/http-transport.js");

function createMockFetch(responses) {
  const calls = [];
  const mockFn = async (url, init) => {
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const handler = responses[key] ?? responses["*"];
    if (!handler) throw new Error(`No mock for ${key}`);
    const result = typeof handler === "function" ? handler(url, init) : handler;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status ?? 200,
      json: async () => result.body,
      body: result.stream ?? null,
    };
  };
  return { fetch: mockFn, calls };
}

describe("HttpTransport", () => {
  const writeCases = [
    { name: "set", route: "PUT /v1/config/key", run: (transport) => transport.set("key", "value") },
    { name: "setMany", route: "PATCH /v1/config", run: (transport) => transport.setMany({ key: "value" }) },
    { name: "remove", route: "DELETE /v1/config/key", run: (transport) => transport.remove("key") },
  ];

  it("resolveAll makes GET /v1/config", async () => {
    const snapshot = { entries: { "app.name": "test" }, scopes: {}, revision: "rev-1", timestamp: "2026-01-01" };
    const { fetch, calls } = createMockFetch({
      "GET /v1/config": { status: 200, body: { data: snapshot, meta: { revision: "rev-1" } } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const result = await transport.resolveAll();
    expect(result).toEqual(snapshot);
    expect(calls.length).toBe(1);
    expect(calls[0].url.includes("/v1/config")).toBeTruthy();
  });

  it("get makes GET /v1/config/{keyPath}", async () => {
    const { fetch } = createMockFetch({
      "GET /v1/config/db/host": { status: 200, body: { data: { key: "db.host", value: "localhost" }, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const value = await transport.get("db.host");
    expect(value).toBe("localhost");
  });

  it("set makes PUT /v1/config/{keyPath} with value body", async () => {
    const { fetch, calls } = createMockFetch({
      "PUT /v1/config/db/host": { status: 200, body: { data: { success: true, revision: "rev-2" }, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const result = await transport.set("db.host", "newhost");
    expect(result.success).toBe(true);
    const sentBody = JSON.parse(calls[0].init.body);
    expect(sentBody).toEqual({ value: "newhost" });
  });

  it("set with ifRevision sends If-Match header", async () => {
    const { fetch, calls } = createMockFetch({
      "PUT /v1/config/key": { status: 200, body: { data: { success: true }, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    await transport.set("key", "val", { ifRevision: "rev-1" });
    expect(calls[0].init.headers["If-Match"]).toBe('"rev-1"');
  });

  it("remove makes DELETE /v1/config/{keyPath}", async () => {
    const { fetch, calls } = createMockFetch({
      "DELETE /v1/config/old/key": { status: 200, body: { data: { success: true }, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    await transport.remove("old.key");
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("setMany makes PATCH /v1/config", async () => {
    const { fetch, calls } = createMockFetch({
      "PATCH /v1/config": { status: 200, body: { data: { success: true, revision: "rev-3" }, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const result = await transport.setMany({ a: 1, b: 2 });
    expect(result.success).toBe(true);
    const sentBody = JSON.parse(calls[0].init.body);
    expect(sentBody).toEqual({ entries: { a: 1, b: 2 } });
  });

  it("listScopes makes GET /v1/scopes", async () => {
    const defs = [{ id: "region", label: "Region" }];
    const { fetch } = createMockFetch({
      "GET /v1/scopes": { status: 200, body: { data: { definitions: defs }, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const result = await transport.listScopes();
    expect(result).toEqual(defs);
  });

  it("listScopeValues makes GET /v1/scopes/:scopeId", async () => {
    const { fetch } = createMockFetch({
      "GET /v1/scopes/region": { status: 200, body: { data: { values: ["us", "eu"] }, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const values = await transport.listScopeValues("region");
    expect(values).toEqual(["us", "eu"]);
  });

  it("inspect makes GET /v1/config/{keyPath}?inspect", async () => {
    const inspection = { key: "db.host", effectiveValue: "localhost", layerValues: { platform: "localhost" } };
    const { fetch, calls } = createMockFetch({
      "GET /v1/config/db/host": { status: 200, body: { data: inspection, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const result = await transport.inspect("db.host");
    expect(result).toEqual(inspection);
    expect(calls[0].url.includes("inspect")).toBeTruthy();
  });

  it("includes Authorization header when token provided", async () => {
    const { fetch, calls } = createMockFetch({
      "GET /v1/config": { status: 200, body: { data: {}, meta: {} } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch, token: "jwt-123" });
    await transport.resolveAll();
    expect(calls[0].init.headers["Authorization"]).toBe("Bearer jwt-123");
  });

  it("close is safe to call", async () => {
    const transport = createHttpTransport({
      baseUrl: "http://localhost:3399",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), body: null }),
    });
    await transport.close();
  });

  it("error response returns WriteResult with error", async () => {
    const { fetch } = createMockFetch({
      "PUT /v1/config/key": { status: 400, body: { data: null, error: { code: "VALIDATION_ERROR", message: "bad" } } },
    });
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch });
    const result = await transport.set("key", "val");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
  });

  it.each(writeCases)("$name preserves valid error results", async ({ route, run }) => {
    const { fetch } = createMockFetch({
      [route]: {
        status: 400,
        body: {
          data: null,
          error: { code: "VALIDATION_ERROR", message: "bad", details: { key: "key" } },
        },
      },
    });
    await expect(run(createHttpTransport({ baseUrl: "http://localhost:3399", fetch }))).resolves.toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "bad", details: { key: "key" } },
    });
  });

  it.each(
    writeCases.flatMap((writeCase) => [
      { ...writeCase, body: { meta: {} }, caseName: "missing success data" },
      { ...writeCase, body: { data: { success: "yes" } }, caseName: "malformed success data" },
    ]),
  )("$name rejects $caseName", async ({ route, run, body }) => {
    const { fetch } = createMockFetch({ [route]: { status: 200, body } });
    await expect(run(createHttpTransport({ baseUrl: "http://localhost:3399", fetch }))).rejects.toThrow();
  });

  it.each(writeCases)("$name rejects malformed errors", async ({ route, run }) => {
    const { fetch } = createMockFetch({
      [route]: {
        status: 400,
        body: { data: null, error: { code: "NOT_A_WEAVER_CODE", message: "bad" } },
      },
    });
    await expect(run(createHttpTransport({ baseUrl: "http://localhost:3399", fetch }))).rejects.toThrow();
  });
});
