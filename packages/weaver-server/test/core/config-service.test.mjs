import { createTestService } from "../setup-service.ts";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";

const schemas = {
  app: { type: "object", properties: { name: { type: "string" }, theme: { type: "string" }, key: { type: "string" } }, additionalProperties: false },
  db: { type: "object", properties: { host: { type: "string" }, port: { type: "number" } }, additionalProperties: false },
  cache: { type: "object", properties: { ttl: { type: "number" } }, additionalProperties: false },
};
const createWeaverConfigService = (options, paths = []) => createTestService(options, schemas, paths);

function createTestProvider(id, layer, entries, writable = true) {
  let data = JSON.parse(JSON.stringify(entries));
  return {
    id,
    layer,
    writable,
    async load() { return { entries: JSON.parse(JSON.stringify(data)) }; },
    async write(key, value) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      deepSet(data, key, value);
      return { success: true };
    },
    async remove(key) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      deepRemove(data, key);
      return { success: true };
    },
    _setData(newData) { data = JSON.parse(JSON.stringify(newData)); },
  };
}

describe("WeaverConfigService read path", () => {
  test("resolveAll returns correct snapshot shape", async () => {
    const provider = createTestProvider("p1", "platform", { app: { name: "test" } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const snapshot = await svc.resolveAll();
    expect(snapshot.entries.app.name).toBe("test");
    expect(snapshot.revision).toBeTruthy();
    expect(snapshot.timestamp).toBeTruthy();
    expect(snapshot.scopes).toEqual({});
  });

  test("get returns correct value via dot-path traversal", async () => {
    const provider = createTestProvider("p1", "platform", { db: { host: "localhost" } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const val = await svc.get("db.host");
    expect(val).toBe("localhost");
  });

  test("getNamespace returns subtree", async () => {
    const provider = createTestProvider("p1", "platform", {
      db: { host: "localhost", port: 5432 },
      cache: { ttl: 60 },
    });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const ns = await svc.getNamespace("db");
    expect(ns.host).toBe("localhost");
    expect(ns.port).toBe(5432);
    expect(ns.ttl).toBe(undefined);
  });

  test("inspect returns provenance", async () => {
    const p1 = createTestProvider("p1", "defaults", { app: { name: "base" } });
    const p2 = createTestProvider("p2", "platform", { app: { name: "override" } });
    const svc = await createWeaverConfigService({
      providers: [p1, p2],
      environment: "dev",
    });

    const info = await svc.inspect("app.name");
    expect(info.key).toBe("app.name");
    expect(info.effectiveValue).toBe("override");
    expect(info.effectiveLayer).toBe("platform");
    expect(info.layerValues["defaults"]).toBe("base");
    expect(info.layerValues["platform"]).toBe("override");
  });

  test("multi-scope: platform + scoped providers grouped correctly", async () => {
    const platform = createTestProvider("p1", "platform", { app: { name: "test" } });
    const acme = createInMemoryStorageProvider({ id: "t1", layer: "tenant:acme", initialEntries: { app: { theme: "dark" } } });
    const globex = createInMemoryStorageProvider({ id: "t2", layer: "tenant:globex", initialEntries: { app: { theme: "light" } } });

    const svc = await createWeaverConfigService({
      providers: [platform, acme, globex],
      environment: "dev",
    }, [[{ scopeId: "tenant", value: "acme" }], [{ scopeId: "tenant", value: "globex" }]]);

    const snapshot = await svc.resolveAll();
    expect(snapshot.entries.app.name).toBe("test");
    expect(snapshot.scopes["tenant:acme"].app.theme).toBe("dark");
    expect(snapshot.scopes["tenant:globex"].app.theme).toBe("light");
  });

  test("get with scopePath merges scope over platform", async () => {
    const platform = createTestProvider("p1", "platform", { app: { theme: "default" } });
    const acme = createInMemoryStorageProvider({ id: "t1", layer: "tenant:acme", initialEntries: { app: { theme: "dark" } } });

    const svc = await createWeaverConfigService({
      providers: [platform, acme],
      environment: "dev",
    }, [[{ scopeId: "tenant", value: "acme" }]]);

    const val = await svc.get("app.theme", { scopePath: [{ scopeId: "tenant", value: "acme" }] });
    expect(val).toBe("dark");
  });

  test("reloadProvider picks up changes", async () => {
    const provider = createTestProvider("p1", "platform", { app: { key: "old" } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    expect(await svc.get("app.key")).toBe("old");

    provider._setData({ app: { key: "new" } });
    await svc.reloadProvider("p1");

    expect(await svc.get("app.key")).toBe("new");
  });

  test("revision changes after reload", async () => {
    const provider = createTestProvider("p1", "platform", { app: { key: "v1" } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const rev1 = svc.revision;
    provider._setData({ app: { key: "v2" } });
    await svc.reloadProvider("p1");
    const rev2 = svc.revision;

    expect(rev1).not.toBe(rev2);
  });

  test("setMany writes multiple entries in one batch", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const result = await svc.setMany("platform", {
      "db.host": "localhost",
      "db.port": 5432,
    });
    expect(result.success).toBe(true);
    expect(await svc.get("db.host")).toBe("localhost");
    expect(await svc.get("db.port")).toBe(5432);
  });
});
