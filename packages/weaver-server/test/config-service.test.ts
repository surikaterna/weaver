import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.js";

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
      expect(await svc.get("_weaver.registry.schemas")).toBe("internal");
    }
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
