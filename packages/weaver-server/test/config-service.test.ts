import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { vi } from "vitest";
import { createWeaverConfigService } from "../src/core/config-service";
import { createTestService } from "./setup-service";

const schemas = {
  app: { type: "object", additionalProperties: true, description: "LEAK" },
  db: { type: "object", additionalProperties: true },
  new: { type: "object", additionalProperties: true },
  missing: { type: "object", additionalProperties: true },
} as const;
const scopePath = [{ scopeId: "tenant", value: "surikat" }];

async function makeService(entries: Record<string, unknown> = {}) {
  const provider = createInMemoryStorageProvider({
    id: "mem-app",
    layer: "app",
    initialEntries: entries,
  });
  return createTestService(
    { providers: [provider], environment: "test" },
    schemas,
  );
}

async function scopedService() {
  const platform = createInMemoryStorageProvider({
    id: "platform",
    layer: "platform",
    initialEntries: { app: { theme: "light" } },
  });
  const tenant = createInMemoryStorageProvider({
    id: "tenant-base",
    layer: "tenant",
  });
  await tenant.writeLayer?.("tenant:surikat", "app.theme", "dark");
  const service = await createTestService(
    { providers: [platform, tenant], environment: "test" },
    schemas,
    [scopePath],
  );
  return { service, tenant };
}

describe("WeaverConfigService", () => {
  it("resolves all entries", async () => {
    const service = await makeService({ app: { name: "weaver", port: 8080 } });
    const snapshot = await service.resolveAll();
    expect(snapshot.entries).toEqual({ app: { name: "weaver", port: 8080 } });
    expect(snapshot.revision).toBeTruthy();
    await service.close?.();
  });

  it("gets a single key", async () => {
    const service = await makeService({ db: { host: "localhost" } });
    expect(await service.get("db.host")).toBe("localhost");
    await service.close?.();
  });

  it("returns undefined for an absent key in a declared namespace", async () => {
    const service = await makeService();
    expect(await service.get("missing.key")).toBeUndefined();
    await service.close?.();
  });

  it("sets a value and updates revision", async () => {
    const service = await makeService();
    const before = service.revision;
    expect((await service.set("app", "new.key", "value")).success).toBe(true);
    expect(await service.get("new.key")).toBe("value");
    expect(service.revision).not.toBe(before);
    await service.close?.();
  });

  it("rejects public writes to protected Weaver metadata paths", async () => {
    const service = await makeService();
    for (const key of [
      "_weaver",
      "_weaver.catalog.registrations",
      "/_weaver",
      "/_weaver/catalog/registrations",
      "[_weaver].catalog.registrations",
    ]) {
      expect((await service.set("app", key, "blocked")).success).toBe(false);
    }
    await service.close?.();
  });

  it("rejects protected removals and batches before public effects", async () => {
    const service = await makeService();
    const before = service.revision;
    for (const key of [
      "_weaver.catalog.registrations",
      "/_weaver/catalog/registrations",
      "[_weaver].catalog.registrations",
    ]) {
      expect((await service.remove("app", key)).success).toBe(false);
      expect(
        (await service.setMany("app", { "app.safe": true, [key]: "blocked" }))
          .success,
      ).toBe(false);
    }
    expect(service.revision).toBe(before);
    expect(await service.get("app.safe")).toBeUndefined();
    await service.close?.();
  });

  it("filters protected metadata from every public read shape", async () => {
    const service = await makeService({ app: { name: "public" } });
    expect((await service.resolveAll()).entries).toEqual({
      app: { name: "public" },
    });
    for (const key of [
      "_weaver",
      "_weaver.catalog",
      "/_weaver",
      "[_weaver].catalog.registrations",
    ]) {
      expect(await service.get(key)).toBeUndefined();
      expect(await service.getNamespace(key)).toEqual({});
      expect(await service.inspect(key)).toEqual({
        key,
        effectiveValue: undefined,
        effectiveLayer: undefined,
        layerValues: {},
      });
    }
    await service.close?.();
  });

  it("fails closed for direct and chained protected mounts", async () => {
    const service = await makeService({
      app: {
        direct: { _weaver: "mount", source: "_weaver.catalog.registrations" },
        bridge: { _weaver: "mount", source: "_weaver.catalog.registrations" },
        chained: { _weaver: "mount", source: "app.bridge" },
        publicValue: { enabled: true },
        publicAlias: { _weaver: "mount", source: "app.publicValue" },
      },
    });
    expect(await service.getNamespace("app")).toEqual({
      publicValue: { enabled: true },
      publicAlias: { enabled: true },
    });
    expect(JSON.stringify(await service.resolveAll())).not.toContain("LEAK");
    await service.close?.();
  });

  it("rejects scoped providers that try to override protected metadata", async () => {
    const tenant = createInMemoryStorageProvider({
      id: "tenant",
      layer: "tenant:surikat",
      initialEntries: { _weaver: { scoped: "private" } },
    });
    await expect(
      createTestService({ providers: [tenant], environment: "test" }, schemas, [
        scopePath,
      ]),
    ).rejects.toThrow();
  });

  it("removes a value", async () => {
    const service = await makeService({ app: { old: true } });
    expect((await service.remove("app", "app.old")).success).toBe(true);
    expect(await service.get("app.old")).toBeUndefined();
    await service.close?.();
  });

  it("fires a validated root delta on set", async () => {
    const service = await makeService();
    const events: unknown[] = [];
    service.onDelta((event) => events.push(event));
    await service.set("app", "app.x", 1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "app", action: "set", value: { x: 1 } }),
      ]),
    );
    await service.close?.();
  });

  it("updates revision for dynamic scoped writes", async () => {
    const { service } = await scopedService();
    const before = service.revision;
    expect(
      (await service.set("tenant:surikat", "app.theme", "blue")).success,
    ).toBe(true);
    expect(service.revision).not.toBe(before);
    expect(await service.get("app.theme", { scopePath })).toBe("blue");
    await service.close?.();
  });

  it("updates revision for dynamic scoped removes", async () => {
    const { service } = await scopedService();
    const before = service.revision;
    expect((await service.remove("tenant:surikat", "app.theme")).success).toBe(
      true,
    );
    expect(service.revision).not.toBe(before);
    expect(await service.get("app.theme", { scopePath })).toBe("light");
    await service.close?.();
  });

  it("reports canonical dynamic scoped layers in inspection", async () => {
    const { service } = await scopedService();
    expect(
      (await service.inspect("app.theme")).layerValues["tenant:surikat"],
    ).toBe("dark");
    await service.close?.();
  });

  it("uses canonical scope keys for full snapshots", async () => {
    const { service } = await scopedService();
    expect((await service.resolveAll()).scopes["tenant:surikat"]).toEqual({
      app: { theme: "dark" },
    });
    await service.close?.();
  });

  it("loads cold inventory before readiness and reuses the validated cache", async () => {
    const { service, tenant } = await scopedService();
    if (!tenant.authority) throw new Error("Missing authority");
    const reads = vi.spyOn(tenant.authority, "readLayer");
    expect(await service.get("app.theme", { scopePath })).toBe("dark");
    expect(await service.get("app.theme", { scopePath })).toBe("dark");
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    await service.close?.();
  });

  it("rejects writes with a stale revision", async () => {
    const service = await makeService();
    expect(
      (await service.set("app", "app.x", 1, { expectedRevision: "stale" }))
        .error?.code,
    ).toBe("REVISION_CONFLICT");
    await service.close?.();
  });

  it("fails startup rather than dropping a required provider", async () => {
    const bad = {
      id: "bad",
      layer: "bad",
      writable: false,
      load: async () => {
        throw new Error("connection failed");
      },
      write: async () => ({ success: false }),
      remove: async () => ({ success: false }),
    };
    await expect(
      createWeaverConfigService({ providers: [bad], environment: "test" }),
    ).rejects.toMatchObject({ code: "PROVIDER_LOAD_FAILED" });
  });

  it("getNamespace returns the nested object at a declared prefix", async () => {
    const service = await makeService({ db: { pool: { min: 1, max: 5 } } });
    expect(await service.getNamespace("db.pool")).toEqual({ min: 1, max: 5 });
    await service.close?.();
  });
});
