import type { ScopeInstance, WeaverConfig } from "@weaver-conf/config-types";
import { defineWeaver, Layers } from "@weaver-conf/config-types";
import { createScopeCache, createScopeResolver } from "../src/scope-resolver";

function makeWeaverConfig(): WeaverConfig {
  return defineWeaver([
    Layers.Static("defaults"),
    Layers.Static("env"),
    Layers.Dynamic("region"),
    Layers.Dynamic("tenant"),
  ]);
}

describe("createScopeResolver", () => {
  test("getForScope returns base value with empty scope path", () => {
    const layerData: Record<string, Record<string, unknown>> = {
      defaults: { database: { host: "localhost", port: 5432 } },
      env: { database: { host: "prod.db.com" } },
    };

    const resolver = createScopeResolver({
      getLayerEntries: (layer) => layerData[layer] ?? {},
      weaverConfig: makeWeaverConfig(),
    });

    expect(resolver.getForScope("database.host", [])).toBe("prod.db.com");
    expect(resolver.getForScope("database.port", [])).toBe(5432);
  });

  test("getForScope returns scoped value that overrides base", () => {
    const layerData: Record<string, Record<string, unknown>> = {
      defaults: { database: { host: "localhost" } },
      env: {},
      "region:eu-west": { database: { host: "eu.db.com" } },
    };

    const scopePath: ScopeInstance[] = [
      { scopeId: "region", value: "eu-west" },
    ];

    const resolver = createScopeResolver({
      getLayerEntries: (layer) => layerData[layer] ?? {},
      weaverConfig: makeWeaverConfig(),
    });

    expect(resolver.getForScope("database.host", scopePath)).toBe("eu.db.com");
  });

  test("multi-level scope path resolves in order", () => {
    const layerData: Record<string, Record<string, unknown>> = {
      defaults: { theme: "light", locale: "en" },
      env: {},
      "region:eu": { locale: "en-GB" },
      "tenant:acme": { theme: "dark", locale: "en-US" },
    };

    const scopePath: ScopeInstance[] = [
      { scopeId: "region", value: "eu" },
      { scopeId: "tenant", value: "acme" },
    ];

    const resolver = createScopeResolver({
      getLayerEntries: (layer) => layerData[layer] ?? {},
      weaverConfig: makeWeaverConfig(),
    });

    // tenant layer is last, overrides region
    expect(resolver.getForScope("theme", scopePath)).toBe("dark");
    expect(resolver.getForScope("locale", scopePath)).toBe("en-US");
  });

  test("LRU cache hit avoids re-resolution", () => {
    let callCount = 0;
    const layerData: Record<string, Record<string, unknown>> = {
      defaults: { x: 1 },
      env: {},
    };

    const resolver = createScopeResolver({
      getLayerEntries: (layer) => {
        callCount++;
        return layerData[layer] ?? {};
      },
      weaverConfig: makeWeaverConfig(),
    });

    // First call populates cache
    resolver.getForScope("x", []);
    const firstCount = callCount;

    // Second call should hit cache
    resolver.getForScope("x", []);
    expect(callCount).toBe(firstCount);
  });

  test("invalidate clears cache", () => {
    let callCount = 0;
    const layerData: Record<string, Record<string, unknown>> = {
      defaults: { x: 1 },
      env: {},
    };

    const resolver = createScopeResolver({
      getLayerEntries: (layer) => {
        callCount++;
        return layerData[layer] ?? {};
      },
      weaverConfig: makeWeaverConfig(),
    });

    resolver.getForScope("x", []);
    const firstCount = callCount;

    resolver.invalidate();

    // After invalidation, must re-resolve
    resolver.getForScope("x", []);
    expect(callCount > firstCount).toBeTruthy();
  });

  test("buildScopedStack returns correct layer order", () => {
    const layerData: Record<string, Record<string, unknown>> = {
      defaults: { a: 1 },
      env: { b: 2 },
      "region:us": { c: 3 },
    };

    const resolver = createScopeResolver({
      getLayerEntries: (layer) => layerData[layer] ?? {},
      weaverConfig: makeWeaverConfig(),
    });

    const scopePath: ScopeInstance[] = [{ scopeId: "region", value: "us" }];
    const stack = resolver.buildScopedStack(scopePath);

    expect(stack.layers.length).toBe(4);
    expect(stack.layers[0]?.layer).toBe("defaults");
    expect(stack.layers[1]?.layer).toBe("env");
    expect(stack.layers[2]?.layer).toBe("region");
    expect(stack.layers[3]?.layer).toBe("region:us");
  });
});

describe("createScopeCache", () => {
  test("get returns undefined on miss", () => {
    const cache = createScopeCache(10);
    expect(cache.get("unknown")).toBe(undefined);
  });

  test("set and get round-trip", () => {
    const cache = createScopeCache(10);
    cache.set("key1", { a: 1 });
    expect(cache.get("key1")).toEqual({ a: 1 });
  });

  test("evicts LRU entries when at capacity", () => {
    const cache = createScopeCache(2);
    cache.set("a", { x: 1 });
    cache.set("b", { x: 2 });
    cache.set("c", { x: 3 }); // Should evict "a"

    expect(cache.get("a")).toBe(undefined);
    expect(cache.get("b")).toEqual({ x: 2 });
    expect(cache.get("c")).toEqual({ x: 3 });
  });

  test("access promotes entry in LRU order", () => {
    const cache = createScopeCache(2);
    cache.set("a", { x: 1 });
    cache.set("b", { x: 2 });

    // Access "a" to promote it
    cache.get("a");

    // Adding "c" should evict "b" (least recently used)
    cache.set("c", { x: 3 });

    expect(cache.get("a")).toEqual({ x: 1 });
    expect(cache.get("b")).toBe(undefined);
    expect(cache.get("c")).toEqual({ x: 3 });
  });

  test("clear removes all entries", () => {
    const cache = createScopeCache(10);
    cache.set("a", { x: 1 });
    cache.set("b", { x: 2 });
    cache.clear();

    expect(cache.get("a")).toBe(undefined);
    expect(cache.get("b")).toBe(undefined);
  });
});
