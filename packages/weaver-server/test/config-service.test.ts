import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.js";
import { isProtectedConfigPath } from "../src/core/protected-config-paths.js";
import { createSSEAdapter } from "../src/transport/sse-adapter.js";

describe("WeaverConfigService", () => {
  async function makeService(entries: Record<string, unknown> = {}) {
    const provider = createInMemoryStorageProvider({
      id: "mem-app",
      layer: "app",
      initialEntries: entries,
    });
    return createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
  }

  it("resolves all entries", async () => {
    const svc = await makeService({ "app.name": "weaver", "app.port": 8080 });
    const snapshot = await svc.resolveAll();
    expect(snapshot.entries["app.name"]).toBe("weaver");
    expect(snapshot.entries["app.port"]).toBe(8080);
    expect(snapshot.revision).toBeTruthy();
  });

  it("gets a single key", async () => {
    const svc = await makeService({ db: { host: "localhost" } });
    const val = await svc.get("db.host");
    expect(val).toBe("localhost");
  });

  it("returns undefined for missing key", async () => {
    const svc = await makeService({});
    const val = await svc.get("missing.key");
    expect(val).toBe(undefined);
  });

  it("sets a value and updates revision", async () => {
    const svc = await makeService({});
    const oldRev = svc.revision;
    const result = await svc.set("app", "new.key", "value");
    expect(result.success).toBe(true);
    const val = await svc.get("new.key");
    expect(val).toBe("value");
    expect(svc.revision).not.toBe(oldRev);
  });

  it("rejects public writes to protected Weaver metadata paths", async () => {
    const svc = await makeService({});
    const keys = [
      "_weaver",
      "_weaver.registry.schemas",
      "/_weaver",
      "/_weaver/registry/schemas",
      "[_weaver].registry.schemas",
    ];

    for (const key of keys) {
      const result = await svc.set("app", key, "blocked");
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("VALIDATION_ERROR");
    }

    expect(await svc.get("_weaver.registry.schemas")).toBe(undefined);
    expect(await svc.get("[_weaver].registry.schemas")).toBe(undefined);
  });

  it("rejects public removals and batches for protected Weaver metadata paths", async () => {
    const keys = [
      "_weaver.registry.schemas",
      "/_weaver/registry/schemas",
      "[_weaver].registry.schemas",
    ];

    for (const key of keys) {
      const svc = await makeService({
        _weaver: { registry: { schemas: "internal" } },
      });
      const removeResult = await svc.remove("app", key);
      const batchResult = await svc.setMany("app", {
        "app.safe": true,
        [key]: "blocked",
      });

      expect(removeResult.success).toBe(false);
      expect(removeResult.error?.code).toBe("VALIDATION_ERROR");
      expect(batchResult.success).toBe(false);
      expect(batchResult.error?.code).toBe("VALIDATION_ERROR");
      expect(await svc.get("app.safe")).toBe(undefined);
      expect(await svc.get("_weaver.registry.schemas")).toBe(undefined);
    }
  });

  it("filters protected metadata from public read shapes", async () => {
    const svc = await makeService({
      app: { name: "public" },
      _weaver: { registry: { schemas: { private: true } } },
    });

    expect((await svc.resolveAll()).entries).toEqual({
      app: { name: "public" },
    });
    for (const path of [
      "_weaver",
      "_weaver.registry.schemas",
      "/_weaver/registry/schemas",
      "[_weaver].registry.schemas",
    ]) {
      expect(await svc.get(path)).toBe(undefined);
      expect(await svc.getNamespace(path)).toEqual({});
      expect(await svc.inspect(path)).toEqual({
        key: path,
        effectiveValue: undefined,
        effectiveLayer: undefined,
        layerValues: {},
      });
    }
  });

  it("fails closed on malformed protected-root aliases without effects", async () => {
    const protectedPaths = [
      "_weaver",
      "/_weaver",
      "[_weaver]",
      "_weaver..registry.schemas",
      "_weaver.__proto__.registry.schemas",
      "_weaver[constructor].registry.schemas",
      "_weaver[prototype].registry.schemas",
    ];
    const calls = { writes: 0, removes: 0 };
    const provider = {
      id: "counting",
      layer: "app",
      writable: true as const,
      async load() {
        return {
          entries: Object.fromEntries(
            protectedPaths.map((key) => [key, "private"]),
          ),
        };
      },
      async write() {
        calls.writes += 1;
        return { success: true } as const;
      },
      async remove() {
        calls.removes += 1;
        return { success: true } as const;
      },
    };
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const revision = svc.revision;
    const deltas: unknown[] = [];
    svc.onDelta((delta) => deltas.push(delta));

    for (const path of protectedPaths) {
      expect(isProtectedConfigPath(path)).toBe(true);
      expect(await svc.get(path)).toBeUndefined();
      expect(await svc.getNamespace(path)).toEqual({});
      expect((await svc.inspect(path)).effectiveValue).toBeUndefined();
      expect((await svc.set("app", path, "blocked")).success).toBe(false);
      expect((await svc.remove("app", path)).success).toBe(false);
      expect(
        (await svc.setMany("app", { safe: true, [path]: "blocked" })).success,
      ).toBe(false);
    }

    expect((await svc.resolveAll()).entries).toEqual({});
    expect(calls).toEqual({ writes: 0, removes: 0 });
    expect(svc.revision).toBe(revision);
    expect(deltas).toEqual([]);
  });

  it("does not classify literal non-root bracket keys as protected", () => {
    for (const path of [
      "[_weaver.registry]",
      "x._weaver",
      "_weaverish",
      "[x._weaver]",
    ]) {
      expect(isProtectedConfigPath(path)).toBe(false);
    }
  });

  it("omits tainted mounts from every public config view", async () => {
    const mount = (source: string) => ({ _weaver: "mount", source });
    const svc = await makeService({
      _weaver: { registry: { schemas: { private: true } } },
      direct: mount("_weaver.registry.schemas"),
      nested: { leak: mount("_weaver.registry.schemas") },
      chained: mount("direct"),
      alias: mount("[_weaver].registry.schemas"),
      cycleA: mount("cycleB"),
      cycleB: mount("cycleA"),
      ordinary: mount("public.value"),
      secret: { _weaver: "secret-ref", provider: "vault", uri: "secret/app" },
      public: { value: "visible" },
    });

    for (const key of ["direct", "nested.leak", "chained", "alias"]) {
      expect(await svc.get(key)).toBeUndefined();
      expect(await svc.getNamespace(key)).toEqual({});
      expect(await svc.inspect(key)).toEqual({
        key,
        effectiveValue: undefined,
        effectiveLayer: undefined,
        layerValues: {},
      });
    }
    expect(await svc.getNamespace("nested")).toEqual({});
    expect((await svc.inspect("nested")).effectiveValue).toEqual({});
    expect(await svc.get("ordinary")).toBe("visible");
    const snapshot = await svc.resolveAll();
    expect(snapshot.entries).toEqual({
      nested: {},
      cycleA: undefined,
      cycleB: undefined,
      ordinary: "visible",
      secret: {
        _weaver: "secret-ref",
        provider: "vault",
        uri: "secret/app",
      },
      public: { value: "visible" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("_weaver.registry.schemas");
  });

  it("resolves scoped mounts only through the public merged view", async () => {
    const platform = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {
        _weaver: { registry: { schemas: { private: true } } },
        public: { value: "visible" },
      },
    });
    const tenant = createInMemoryStorageProvider({
      id: "tenant",
      layer: "tenant:acme",
      initialEntries: {
        leak: { _weaver: "mount", source: "_weaver.registry.schemas" },
        ordinary: { _weaver: "mount", source: "public.value" },
      },
    });
    const svc = await createWeaverConfigService({
      providers: [platform, tenant],
      environment: "test",
    });
    const scopePath = [{ scopeId: "tenant", value: "acme" }];

    expect(await svc.get("leak", { scopePath })).toBeUndefined();
    expect(await svc.getNamespace("leak", { scopePath })).toEqual({});
    expect(await svc.get("ordinary", { scopePath })).toBe("visible");
    expect((await svc.resolveAll()).scopes["tenant:acme"]).toEqual({
      ordinary: "visible",
    });
    expect((await svc.inspect("leak")).layerValues).toEqual({});
  });

  it("projects tainted mount writes through deltas and SSE", async () => {
    const mount = (source: string) => ({ _weaver: "mount", source });
    const platform = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {
        _weaver: { registry: { schemas: { private: true } } },
        public: { value: "visible" },
      },
    });
    const tenant = createInMemoryStorageProvider({
      id: "tenant-acme",
      layer: "tenant:acme",
      initialEntries: {},
    });
    const svc = await createWeaverConfigService({
      providers: [platform, tenant],
      environment: "test",
    });
    const deltas: Array<{ key: string; value?: unknown; action: string }> = [];
    svc.onDelta((delta) => deltas.push(delta));
    const sseClient = await createSSEAdapter({
      configService: svc,
    }).createClient();

    await svc.set("platform", "direct", mount("_weaver.registry.schemas"));
    await svc.set("platform", "nested", {
      visible: true,
      leak: mount("_weaver.registry.schemas"),
    });
    await svc.set("platform", "chained", mount("direct"));
    await svc.set("platform", "alias", mount("[_weaver].registry.schemas"));
    await svc.set("tenant:acme", "scoped", mount("direct"));

    expect(deltas.slice(0, 5).map(({ key, value }) => [key, value])).toEqual([
      ["direct", undefined],
      ["nested", { visible: true }],
      ["chained", undefined],
      ["alias", undefined],
      ["scoped", undefined],
    ]);
    const protectedEvents = JSON.stringify({
      deltas: deltas.slice(0, 5),
      sse: sseClient.messages.slice(0, 6),
    });
    expect(protectedEvents).not.toContain("_weaver");
    expect(protectedEvents).not.toContain("mount");
    expect(protectedEvents).not.toContain("_weaver.registry.schemas");

    await svc.set("platform", "ordinary", mount("public.value"));
    await svc.remove("platform", "ordinary");
    expect(deltas.at(-2)?.value).toEqual(mount("public.value"));
    expect(deltas.at(-1)).toEqual(
      expect.objectContaining({
        action: "remove",
        key: "ordinary",
        value: null,
      }),
    );
    sseClient.close();
  });

  it("removes a value", async () => {
    const svc = await makeService({ "rm.key": "gone" });
    const result = await svc.remove("app", "rm.key");
    expect(result.success).toBe(true);
    const val = await svc.get("rm.key");
    expect(val).toBe(undefined);
  });

  it("fires delta on set", async () => {
    const svc = await makeService({});
    const deltas: unknown[] = [];
    svc.onDelta((d) => deltas.push(d));
    await svc.set("app", "x", 1);
    expect(deltas.length).toBe(1);
  });

  it("updates revision for dynamic scoped writes", async () => {
    const scopedEntries = new Map<string, Record<string, unknown>>();
    const tenantBaseProvider = {
      id: "tenant-base",
      layer: "tenant",
      writable: true as const,
      async load() {
        return { entries: {} };
      },
      async loadLayer(layer: string) {
        return { entries: { ...(scopedEntries.get(layer) ?? {}) } };
      },
      async write(_key: string, _value: unknown) {
        return { success: true } as const;
      },
      async writeLayer(layer: string, key: string, value: unknown) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        entries[key] = value;
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
      async remove(_key: string) {
        return { success: true } as const;
      },
      async removeLayer(layer: string, key: string) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        delete entries[key];
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
    };
    const platformProvider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const svc = await createWeaverConfigService({
      providers: [platformProvider, tenantBaseProvider],
      environment: "test",
    });

    const oldRev = svc.revision;
    const setResult = await svc.set("tenant:surikat", "app.theme", "dark");

    expect(setResult.success).toBe(true);
    expect(svc.revision).not.toBe(oldRev);
  });

  it("updates revision for dynamic scoped removes", async () => {
    const scopedEntries = new Map<string, Record<string, unknown>>();
    scopedEntries.set("tenant:surikat", { "app.theme": "dark" });

    const tenantBaseProvider = {
      id: "tenant-base",
      layer: "tenant",
      writable: true as const,
      async load() {
        return { entries: {} };
      },
      async loadLayer(layer: string) {
        return { entries: { ...(scopedEntries.get(layer) ?? {}) } };
      },
      async write(_key: string, _value: unknown) {
        return { success: true } as const;
      },
      async writeLayer(layer: string, key: string, value: unknown) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        entries[key] = value;
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
      async remove(_key: string) {
        return { success: true } as const;
      },
      async removeLayer(layer: string, key: string) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        delete entries[key];
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
    };
    const platformProvider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const svc = await createWeaverConfigService({
      providers: [platformProvider, tenantBaseProvider],
      environment: "test",
    });

    await svc.set("tenant:surikat", "app.theme", "dark");
    const revBeforeRemove = svc.revision;
    const removeResult = await svc.remove("tenant:surikat", "app.theme");

    expect(removeResult.success).toBe(true);
    expect(svc.revision).not.toBe(revBeforeRemove);
  });

  it("reports canonical dynamic scoped layers in inspect output", async () => {
    const scopedEntries = new Map<string, Record<string, unknown>>();
    const tenantBaseProvider = {
      id: "tenant-base",
      layer: "tenant",
      writable: true as const,
      async load() {
        return { entries: {} };
      },
      async loadLayer(layer: string) {
        return { entries: { ...(scopedEntries.get(layer) ?? {}) } };
      },
      async write(_key: string, _value: unknown) {
        return { success: true } as const;
      },
      async writeLayer(layer: string, key: string, value: unknown) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        entries[key] = value;
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
      async remove(_key: string) {
        return { success: true } as const;
      },
      async removeLayer(layer: string, key: string) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        delete entries[key];
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
    };
    const platformProvider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const svc = await createWeaverConfigService({
      providers: [platformProvider, tenantBaseProvider],
      environment: "test",
    });

    await svc.set("tenant:surikat", "app.theme", "dark");
    const inspection = await svc.inspect("app.theme");

    expect(inspection.layerValues["tenant:surikat"]).toBe("dark");
    expect(inspection.effectiveLayer).toBe("tenant:surikat");
  });

  it("uses canonical dynamic scoped layers in resolveAll scopes", async () => {
    const scopedEntries = new Map<string, Record<string, unknown>>();
    const tenantBaseProvider = {
      id: "tenant-base",
      layer: "tenant",
      writable: true as const,
      async load() {
        return { entries: {} };
      },
      async loadLayer(layer: string) {
        return { entries: { ...(scopedEntries.get(layer) ?? {}) } };
      },
      async write(_key: string, _value: unknown) {
        return { success: true } as const;
      },
      async writeLayer(layer: string, key: string, value: unknown) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        entries[key] = value;
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
      async remove(_key: string) {
        return { success: true } as const;
      },
      async removeLayer(layer: string, key: string) {
        const entries = { ...(scopedEntries.get(layer) ?? {}) };
        delete entries[key];
        scopedEntries.set(layer, entries);
        return { success: true } as const;
      },
    };
    const platformProvider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const svc = await createWeaverConfigService({
      providers: [platformProvider, tenantBaseProvider],
      environment: "test",
    });

    await svc.set("tenant:surikat", "app.theme", "dark");
    const snapshot = await svc.resolveAll();

    expect(snapshot.scopes["tenant:surikat"]).toEqual({
      app: { theme: "dark" },
    });
  });

  it("warms dynamic scope cache from one normalized load", async () => {
    const loadLayerCalls: string[] = [];
    const tenantBaseProvider = {
      id: "tenant-base",
      layer: "tenant",
      writable: true as const,
      async load() {
        return { entries: {} };
      },
      async loadLayer(layer: string) {
        loadLayerCalls.push(layer);
        if (layer === "tenant:surikat") {
          return { entries: { app: { theme: "dark" } } };
        }
        return { entries: {} };
      },
      async write(_key: string, _value: unknown) {
        return { success: true } as const;
      },
      async writeLayer(_layer: string, _key: string, _value: unknown) {
        return { success: true } as const;
      },
      async remove(_key: string) {
        return { success: true } as const;
      },
      async removeLayer(_layer: string, _key: string) {
        return { success: true } as const;
      },
    };
    const platformProvider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: { app: { theme: "light" } },
    });
    const svc = await createWeaverConfigService({
      providers: [platformProvider, tenantBaseProvider],
      environment: "test",
    });

    const val = await svc.get("app.theme", {
      scopePath: [{ scopeId: "tenant", value: "surikat" }],
    });
    expect(val).toBe("dark");

    await svc.get("app.theme", {
      scopePath: [{ scopeId: "tenant", value: "surikat" }],
    });

    expect(loadLayerCalls).toEqual(["tenant:surikat"]);
  });

  it("rejects write with stale revision", async () => {
    const svc = await makeService({});
    const result = await svc.set("app", "k", "v", {
      expectedRevision: "stale-rev",
    });
    expect(result.success).toBe(false);
  });

  it("handles degraded providers gracefully", async () => {
    const badProvider = {
      id: "bad",
      layer: "core",
      writable: false as const,
      async load() {
        throw new Error("connection failed");
      },
    };
    const goodProvider = createInMemoryStorageProvider({
      id: "good",
      layer: "app",
      initialEntries: { k: "v" },
    });
    const svc = await createWeaverConfigService({
      providers: [badProvider, goodProvider],
      environment: "test",
    });
    expect(svc.degradedProviders).toEqual(["bad"]);
    const val = await svc.get("k");
    expect(val).toBe("v");
  });

  it("getNamespace returns nested object at prefix", async () => {
    const svc = await makeService({
      app: { name: "w", port: 3000 },
      db: { host: "x" },
    });
    const ns = await svc.getNamespace("app");
    expect(ns.name).toBe("w");
    expect(ns.port).toBe(3000);
  });
});
