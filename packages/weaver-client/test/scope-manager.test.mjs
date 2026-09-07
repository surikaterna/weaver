import { createScopeLoader } from "../src/scope-manager.js";

function createMockSnapshot() {
  return {
    entries: { db: { host: "localhost" } },
    scopes: {
      "tenant:tenant-a": { feature: { x: true } },
      "tenant:tenant-b": { feature: { y: "hello" } },
    },
    revision: "rev-001",
    timestamp: "2026-01-01T00:00:00Z",
  };
}

function createMockTransport(snapshot = createMockSnapshot()) {
  return {
    async resolveAll() { return snapshot; },
    async get() { return undefined; },
    async getNamespace() { return {}; },
    subscribe() { return () => {}; },
    async close() {},
  };
}

describe("ScopeLoader", () => {
  test("eager mode: all scopes loaded immediately", () => {
    const sl = createScopeLoader({
      mode: "eager",
      transport: createMockTransport(),
      initialSnapshot: createMockSnapshot(),
    });
    expect(sl.getScopeState([{ scopeId: "tenant", value: "tenant-a" }])).toEqual({ feature: { x: true } });
    expect(sl.getScopeState([{ scopeId: "tenant", value: "tenant-b" }])).toEqual({ feature: { y: "hello" } });
    expect(sl.loadedScopes().length).toBe(2);
  });

  test("lazy mode: scope not loaded until preloadScope called", () => {
    const sl = createScopeLoader({
      mode: "lazy",
      transport: createMockTransport(),
      initialSnapshot: createMockSnapshot(),
    });
    expect(sl.getScopeState([{ scopeId: "tenant", value: "tenant-a" }])).toBe(undefined);
    expect(sl.loadedScopes().length).toBe(0);
  });

  test("lazy mode: preloadScope loads and caches", async () => {
    const sl = createScopeLoader({
      mode: "lazy",
      transport: createMockTransport(),
      initialSnapshot: createMockSnapshot(),
    });
    await sl.preloadScope([{ scopeId: "tenant", value: "tenant-a" }]);
    expect(sl.getScopeState([{ scopeId: "tenant", value: "tenant-a" }])).toEqual({ feature: { x: true } });
    expect(sl.loadedScopes().includes("tenant:tenant-a")).toBe(true);
  });

  test("hot mode: snapshot scopes loaded, others lazy", () => {
    const sl = createScopeLoader({
      mode: "hot",
      transport: createMockTransport(),
      initialSnapshot: createMockSnapshot(),
    });
    expect(sl.getScopeState([{ scopeId: "tenant", value: "tenant-a" }])).toEqual({ feature: { x: true } });
    expect(sl.getScopeState([{ scopeId: "tenant", value: "unknown" }])).toBe(undefined);
  });

  test("applyDelta updates correct scope state", () => {
    const sl = createScopeLoader({
      mode: "eager",
      transport: createMockTransport(),
      initialSnapshot: createMockSnapshot(),
    });
    const scopeA = [{ scopeId: "tenant", value: "tenant-a" }];
    sl.applyDelta({ action: "set", key: "feature.x", value: false, layer: "tenant:tenant-a", environment: "prod", timestamp: "t1" }, scopeA);
    expect(sl.getScopeState(scopeA).feature.x).toBe(false);
  });

  test("applyDelta uses canonical deep paths for set and remove", () => {
    const sl = createScopeLoader({
      mode: "hot",
      transport: createMockTransport(),
      initialSnapshot: createMockSnapshot(),
    });
    const scopeA = [{ scopeId: "tenant", value: "tenant-a" }];
    sl.applyDelta({ action: "set", key: "feature[flag]", value: "new", layer: "tenant:tenant-a", environment: "prod", timestamp: "t1" }, scopeA);
    sl.applyDelta({ action: "remove", key: "feature.x", value: null, layer: "tenant:tenant-a", environment: "prod", timestamp: "t2" }, scopeA);

    expect(sl.getScopeState(scopeA)).toEqual({ feature: { flag: "new" } });
  });

  test("loadedScopes tracks which scopes are loaded", async () => {
    const sl = createScopeLoader({
      mode: "lazy",
      transport: createMockTransport(),
      initialSnapshot: createMockSnapshot(),
    });
    expect(sl.loadedScopes().length).toBe(0);
    await sl.preloadScope([{ scopeId: "tenant", value: "tenant-b" }]);
    expect(sl.loadedScopes().includes("tenant:tenant-b")).toBe(true);
    expect(sl.loadedScopes().length).toBe(1);
  });
});
