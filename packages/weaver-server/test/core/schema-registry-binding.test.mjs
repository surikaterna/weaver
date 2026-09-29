import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import {
  createPersistentSchemaRegistry,
  createSchemaRegistry,
} from "../../src/core/schema-registry.ts";

function providerWithEntries(initialEntries = {}) {
  const provider = createInMemoryStorageProvider({
    id: "platform",
    layer: "platform",
    initialEntries,
  });
  const write = vi.spyOn(provider, "write");
  return { provider, write };
}

function registration(environment = "dev") {
  return {
    serviceId: "svc",
    environment,
    owner: { name: "svc", contact: "svc@example.com" },
    schema: { type: "object", properties: { name: { type: "string" } } },
    fragmentSlots: [],
  };
}

async function service(provider, environment = "dev") {
  return createWeaverConfigService({ providers: [provider], environment });
}

describe("config service registry authority", () => {
  test("binds confirmed empty persistence once and hydrates a new service on the same provider", async () => {
    const { provider, write } = providerWithEntries();
    const originalService = await service(provider);
    const original = await createPersistentSchemaRegistry({
      configService: originalService,
      environment: "wrong-default",
    });
    const registered = await original.register({ ...registration(), environment: "" });
    expect(registered.success).toBe(true);
    expect(await original.getSchema("svc", "dev")).toEqual(registration().schema);
    expect(write).toHaveBeenCalledTimes(1);

    const restartedService = await service(provider);
    const restarted = await createPersistentSchemaRegistry({ configService: restartedService });
    expect(restarted.listRegisteredSchemaIdentities()).toEqual(
      original.listRegisteredSchemaIdentities(),
    );
    expect(await restarted.getSchema("svc", "dev")).toEqual(registration().schema);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await restartedService.get("_weaver.registry.schemas")).toBeUndefined();
  });

  test("rejects every duplicate before provider IO and keeps original authority usable", async () => {
    const { provider, write } = providerWithEntries();
    const configService = await service(provider);
    const original = await createPersistentSchemaRegistry({ configService });
    const revision = configService.revision;
    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(/already has/);
    expect(() => createSchemaRegistry({ configService })).toThrow(/already has/);
    expect(write).not.toHaveBeenCalled();
    expect(configService.revision).toBe(revision);
    expect(original.listAll()).toEqual({});
    expect((await original.register(registration())).success).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("reserves the first hydration against concurrent binding attempts", async () => {
    const { provider, write } = providerWithEntries();
    const configService = await service(provider);
    const first = createPersistentSchemaRegistry({ configService });
    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(/already has/);
    const original = await first;
    expect(original.listAll()).toEqual({});
    expect(write).not.toHaveBeenCalled();
  });

  test("initializes one empty in-memory authority without persisting metadata", async () => {
    const { provider, write } = providerWithEntries();
    const configService = await service(provider);
    const original = createSchemaRegistry({ configService });
    expect((await original.register(registration())).success).toBe(true);
    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(/already has/);
    expect(write).not.toHaveBeenCalled();
    expect(await original.getSchema("svc", "dev")).toEqual(registration().schema);
  });

  test("legacy caller-provided registered-write registry cannot replace the bound authority", async () => {
    const { provider } = providerWithEntries();
    const configService = await service(provider);
    const bound = createSchemaRegistry({ configService });
    const caller = createSchemaRegistry({ configService: {} });
    expect((await caller.register(registration())).success).toBe(true);
    expect((await configService.setRegisteredObject("platform", "/svc", { name: "ok" }, {
      schemaRegistry: caller,
    })).success).toBe(true);
    expect(bound.listAll()).toEqual({});
    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(/already has/);
    expect((await bound.register(registration())).success).toBe(true);
  });

  test("does not initialize empty authority over corrupt persisted bytes", async () => {
    const brokenRoot = providerWithEntries({ _weaver: null });
    const brokenService = await service(brokenRoot.provider);
    expect(() => createSchemaRegistry({ configService: brokenService })).toThrow(/root is invalid/);
    await expect(createPersistentSchemaRegistry({ configService: brokenService })).rejects.toThrow(/root is invalid/);
    expect(brokenRoot.write).not.toHaveBeenCalled();
    for (const registry of [
      {},
      { schemas: null },
      { schemas: [] },
      { schemas: { version: 2, environments: [] } },
    ]) {
      const { provider, write } = providerWithEntries({ _weaver: { registry } });
      const configService = await service(provider);
      expect(() => createSchemaRegistry({ configService })).toThrow(/must be hydrated/);
      await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    }
  });

  test("fails closed when provider loading is unavailable rather than assuming empty", async () => {
    const provider = {
      id: "platform",
      layer: "platform",
      writable: true,
      load: vi.fn().mockRejectedValue(new Error("offline")),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const configService = await service(provider);
    expect(() => createSchemaRegistry({ configService })).toThrow(/unavailable/);
    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(/unavailable/);
    expect(provider.write).not.toHaveBeenCalled();
  });
});
