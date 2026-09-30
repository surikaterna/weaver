
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
      json: async () => ({ ...result.body, meta: { revision: "mock", timestamp: "2026-01-01T00:00:00Z", ...result.body?.meta } }),
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
  )("$name returns unknown for $caseName", async ({ route, run, body }) => {
    const { fetch } = createMockFetch({ [route]: { status: 200, body } });
    await expect(run(createHttpTransport({ baseUrl: "http://localhost:3399", fetch }))).resolves.toMatchObject({ success: false, error: { code: "WRITE_OUTCOME_UNKNOWN" } });
  });

  it.each(writeCases)("$name treats malformed errors as unknown", async ({ route, run }) => {
    const { fetch } = createMockFetch({
      [route]: {
        status: 400,
        body: { data: null, error: { code: "NOT_A_WEAVER_CODE", message: "bad" } },
      },
    });
    await expect(run(createHttpTransport({ baseUrl: "http://localhost:3399", fetch }))).resolves.toMatchObject({ success: false, error: { code: "WRITE_OUTCOME_UNKNOWN" } });
  });

  it.each(writeCases)("$name reports unknown on dispatched connection or receipt loss without retry", async ({ run }) => {
    for (const errorAt of ["fetch", "json"]) {
      let calls = 0;
      const transport = createHttpTransport({ baseUrl: "http://localhost:3399", retry: { maxAttempts: 5 }, fetch: async () => {
        calls++;
        if (errorAt === "fetch") throw new Error("connection reset after dispatch");
        return { ok: true, status: 200, json: async () => { throw new Error("response lost"); } };
      } });
      const result = await run(transport);
      expect(result).toMatchObject({ success: false, error: { code: "WRITE_OUTCOME_UNKNOWN" } });
      expect(calls).toBe(1);
    }
  });

  it("proves no-send for invalid path and unserializable body", async () => {
    let calls = 0;
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch: async () => { calls++; throw new Error("unexpected send"); } });
    const circular = {}; circular.self = circular;
    for (const result of [await transport.set("billing[", 1), await transport.remove("billing["), await transport.set("billing", circular), await transport.setMany({ billing: circular })]) {
      expect(result).toMatchObject({ success: false, error: { code: "WRITE_UNAVAILABLE" } });
    }
    expect(calls).toBe(0);
  });

  it("never retries an aborted write after dispatch", async () => {
    let calls = 0;
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", timeout: 5, fetch: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    expect(await transport.set("billing.mode", "ok")).toMatchObject({ error: { code: "WRITE_OUTCOME_UNKNOWN" } });
    expect(calls).toBe(1);
  });

  it("encodes bracket segments, literal dotted names and numeric object members without raw brackets", async () => {
    const urls = [];
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch: async (url) => {
      urls.push(new URL(url).pathname);
      return { ok: true, status: 200, json: async () => ({ data: { success: true }, meta: { revision: "r", timestamp: "now" } }) };
    } });
    await transport.set("billing.items[0]", "x");
    await transport.remove("billing[theme.dark]");
    await transport.set("billing.0", "object property");
    expect(urls).toEqual(["/v1/config/billing/items/0", "/v1/config/billing/theme.dark", "/v1/config/billing/0"]);
  });

  it.each([
    [401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [400, "SCHEMA_NOT_REGISTERED"],
    [400, "UNSUPPORTED_OPERATION"], [400, "VALIDATION_ERROR"], [500, "INTERNAL_ERROR"],
  ])("keeps parsed HTTP %i %s server error intact", async (status, code) => {
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch: async () => ({
      ok: false, status, json: async () => ({ data: null, meta: { revision: "r", timestamp: "now" }, error: { code, message: "server decision" } }),
    }) });
    expect(await transport.set("billing.mode", "x")).toEqual({ success: false, error: { code, message: "server decision" } });
  });

  it("classifies invalid JSON after a received HTTP status as unknown", async () => {
    const transport = createHttpTransport({ baseUrl: "http://localhost:3399", fetch: async () => ({
      ok: false, status: 400, json: async () => { throw new SyntaxError("invalid JSON"); },
    }) });
    expect(await transport.remove("billing.mode")).toMatchObject({ error: { code: "WRITE_OUTCOME_UNKNOWN" } });
  });

  it.each(writeCases)("$name settles at deadline when fetch ignores abort", async ({ run }) => {
    vi.useFakeTimers();
    try {
      const errors = [];
      let calls = 0;
      const transport = createHttpTransport({ baseUrl: "http://localhost:3399", timeout: 5, onError: (error) => errors.push(error), fetch: async () => {
        calls++;
        return new Promise(() => {});
      } });
      const pending = run(transport);
      await vi.advanceTimersByTimeAsync(5);
      expect(await pending).toMatchObject({ success: false, error: { code: "WRITE_OUTCOME_UNKNOWN" } });
      expect(calls).toBe(1);
      expect(errors).toEqual([expect.objectContaining({ type: "timeout", retryable: false })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["late success", "late rejection"])("ignores %s after dispatch deadline", async (outcome) => {
    vi.useFakeTimers();
    try {
      let finish;
      let fail;
      let calls = 0;
      const errors = [];
      const transport = createHttpTransport({ baseUrl: "http://localhost:3399", timeout: 5, onError: (error) => errors.push(error), fetch: () => {
        calls++;
        return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      } });
      const pending = transport.set("billing.mode", "x");
      await vi.advanceTimersByTimeAsync(5);
      expect(await pending).toMatchObject({ error: { code: "WRITE_OUTCOME_UNKNOWN" } });
      if (outcome === "late success") finish({ ok: true, json: async () => ({ data: { success: true }, meta: { revision: "r", timestamp: "now" } }) });
      else fail(new Error("late connection failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(errors).toEqual([expect.objectContaining({ type: "timeout", retryable: false })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["late JSON", "late JSON rejection"])("bounds %s decoding even after fetch has fulfilled", async (outcome) => {
    vi.useFakeTimers();
    try {
      let finishJson;
      let failJson;
      const transport = createHttpTransport({ baseUrl: "http://localhost:3399", timeout: 5, fetch: async () => ({
        ok: true, json: () => new Promise((resolve, reject) => { finishJson = resolve; failJson = reject; }),
      }) });
      const pending = transport.setMany({ "billing.mode": "x" });
      await vi.advanceTimersByTimeAsync(5);
      expect(await pending).toMatchObject({ error: { code: "WRITE_OUTCOME_UNKNOWN" } });
      if (outcome === "late JSON") finishJson({ data: { success: true }, meta: { revision: "r", timestamp: "now" } });
      else failJson(new Error("late JSON failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds validated registered writes without changing their error result contract", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const errors = [];
      const transport = createHttpTransport({ baseUrl: "http://localhost:3399", timeout: 5, onError: (error) => errors.push(error), fetch: async () => {
        calls++;
        return new Promise(() => {});
      } });
      const pending = transport.setRegisteredObject("/billing", {});
      const result = pending.then(() => null, (error) => error);
      await vi.advanceTimersByTimeAsync(5);
      expect((await result).code).toBe("WRITE_OUTCOME_UNKNOWN");
      expect(calls).toBe(1);
      expect(errors).toEqual([expect.objectContaining({ type: "timeout", retryable: false })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["late success", "late rejection"])("keeps registered %s from changing timed-out result", async (outcome) => {
    vi.useFakeTimers();
    try {
      let finish;
      let fail;
      const errors = [];
      let calls = 0;
      const transport = createHttpTransport({ baseUrl: "http://localhost:3399", timeout: 5, onError: (error) => errors.push(error), fetch: () => {
        calls++;
        return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      } });
      const pending = transport.patchRegisteredPath("/billing/mode", "x").then(() => null, (error) => error);
      await vi.advanceTimersByTimeAsync(5);
      expect((await pending).code).toBe("WRITE_OUTCOME_UNKNOWN");
      if (outcome === "late success") finish(new Response(JSON.stringify({ data: { success: true }, meta: { revision: "r", timestamp: "now" } }), { status: 200, headers: { "content-type": "application/json" } }));
      else fail(new Error("late connection failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(errors).toEqual([expect.objectContaining({ type: "timeout", retryable: false })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds registered JSON receipt when fetch resolves before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const errors = [];
      const transport = createHttpTransport({ baseUrl: "http://localhost:3399", timeout: 5, onError: (error) => errors.push(error), fetch: async () => ({
        status: 200, ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => new Promise(() => {}),
      }) });
      const pending = transport.setRegisteredObject("/billing", {}).then(() => null, (error) => error);
      await vi.advanceTimersByTimeAsync(5);
      expect((await pending).code).toBe("WRITE_OUTCOME_UNKNOWN");
      expect(errors).toEqual([expect.objectContaining({ type: "timeout", retryable: false })]);
    } finally {
      vi.useRealTimers();
    }
  });
});
