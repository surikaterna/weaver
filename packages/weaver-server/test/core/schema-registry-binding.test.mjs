import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import {
  readPersistentRegistry,
  removeInternalConfig,
  writeInternalConfig,
} from "../../src/core/config-service-internal.ts";
import { createScopeManager } from "../../src/core/scope-manager.ts";
import { createRestAdapter } from "../../src/transport/rest-adapter.ts";
import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
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
  test.each([
    "billing.mode", "/billing/mode", "billing[mode]", "[billing.mode]",
    "_weaver.other", "_weaver.registry.schemas.child",
    "/_weaver/registry/schemas", "[_weaver].registry.schemas",
    "__proto__.registry", "constructor", "prototype", "[__proto__].registry",
  ])("rejects noncanonical persistent key %s before binding or registry IO", async (key) => {
    const { provider, write } = providerWithEntries();
    const configService = await service(provider);
    const load = vi.spyOn(provider, "load");
    const remove = vi.spyOn(provider, "remove");
    const flush = vi.fn(async () => {});
    provider.dirty = true;
    provider.flush = flush;
    const revision = configService.revision;
    const deltas = [];
    configService.onDelta((delta) => deltas.push(delta));

    await expect(createPersistentSchemaRegistry({ configService, key })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Persistent schema registry key must be the canonical internal key",
    });
    expect([load.mock.calls.length, write.mock.calls.length, remove.mock.calls.length, flush.mock.calls.length]).toEqual([0, 0, 0, 0]);
    expect(configService.revision).toBe(revision);
    expect(deltas).toEqual([]);
    expect((await provider.load()).entries).toEqual({});
    expect(await configService.get("billing.mode")).toBeUndefined();

    const registry = await createPersistentSchemaRegistry({ configService });
    expect((await registry.register(registration())).success).toBe(true);
    const restarted = await service(provider);
    const hydrated = await createPersistentSchemaRegistry({ configService: restarted });
    expect(await hydrated.getSchema("svc", "dev")).toEqual(registration().schema);
    expect(await restarted.get("_weaver.registry.schemas")).toBeUndefined();
    expect(await restarted.getNamespace("_weaver.registry")).toEqual({});
    expect((await restarted.inspect("_weaver.registry.schemas")).layerValues).toEqual({});
    const rest = createRestAdapter({ configService: restarted, schemaRegistry: hydrated });
    const restSnapshot = await rest.handleRequest("GET", "/v1/config", {
      params: {}, query: {}, headers: {},
    });
    expect(JSON.stringify(restSnapshot.body)).not.toContain("_weaver.registry.schemas");
    expect(JSON.stringify(restSnapshot.body)).not.toContain("svc@example.com");
    const scomp = createWeaverScompService({
      configService: restarted, schemaRegistry: hydrated,
      scopeManager: createScopeManager({ configService: restarted, schemaRegistry: hydrated }),
      defaultEnvironment: "dev",
    });
    const scompRead = await scomp.router["weaver-config-v1.get"].handler({ key: "_weaver.registry.schemas" });
    expect(scompRead).toEqual({ value: undefined });
    const scompSnapshot = await scomp.router["weaver-config-v1.resolveAll"].handler({});
    expect(JSON.stringify(scompSnapshot)).not.toContain("svc@example.com");
  });

  test("explicit canonical key works and a legacy public custom-key value is never erased", async () => {
    const legacy = { version: 2, environments: { old: { schemas: {}, slots: {} } } };
    const { provider, write } = providerWithEntries({ billing: { mode: legacy } });
    const configService = await service(provider);
    const revision = configService.revision;
    await expect(createPersistentSchemaRegistry({ configService, key: "billing.mode" })).rejects.toThrow(/canonical internal key/);
    expect(write).not.toHaveBeenCalled();
    expect(configService.revision).toBe(revision);
    expect(await configService.get("billing.mode")).toEqual(legacy);
    const registry = await createPersistentSchemaRegistry({ configService, key: "_weaver.registry.schemas" });
    expect((await registry.register(registration())).success).toBe(true);
    expect((await provider.load()).entries.billing.mode).toEqual(legacy);
    expect(await configService.get("_weaver.registry.schemas")).toBeUndefined();
    const restarted = await service(provider);
    const hydrated = await createPersistentSchemaRegistry({ configService: restarted });
    expect(await hydrated.getSchema("svc", "dev")).toEqual(registration().schema);
    expect((await provider.load()).entries.billing.mode).toEqual(legacy);
  });

  test("private registry guards reject public reads/writes/removes while scope and pinned keys remain private", async () => {
    const platform = createInMemoryStorageProvider({ id: "platform", layer: "platform" });
    const tenant = createInMemoryStorageProvider({ id: "tenant", layer: "tenant" });
    const configService = await createWeaverConfigService({ providers: [platform, tenant], environment: "dev" });
    const registry = await createPersistentSchemaRegistry({ configService });
    const revision = configService.revision;
    for (const key of ["billing.mode", "_weaver.registry.schemas.child", "_weaver.other"]) {
      await expect(readPersistentRegistry(configService, "platform", key)).rejects.toThrow(/canonical internal key/);
      expect((await writeInternalConfig(configService, "platform", key, "blocked")).success).toBe(false);
      expect((await removeInternalConfig(configService, "platform", key)).success).toBe(false);
    }
    expect(configService.revision).toBe(revision);
    expect((await platform.load()).entries).toEqual({});

    const scopes = createScopeManager({ configService, schemaRegistry: registry });
    expect((await scopes.provision({ scopeId: "tenant", value: "one", actor: "admin" })).success).toBe(true);
    expect(await configService.get("_weaver.scope.tenant", { scopePath: [{ scopeId: "tenant", value: "one" }] })).toBeUndefined();
    expect((await scopes.deprovision({ scopeId: "tenant", value: "one", actor: "admin" })).success).toBe(true);
    expect((await writeInternalConfig(configService, "platform", "_weaver.pinned.backup", { confirmed: true })).success).toBe(true);
    expect(await configService.get("_weaver.pinned.backup")).toBeUndefined();
  });
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
    expect(await original.resolveAnchor("/svc")).not.toBeNull();
    expect(await original.resolveAnchor("/svc")).toEqual(
      await original.resolveAnchor("/svc", "dev"),
    );
    expect(await original.resolveAnchor("/svc", "other")).toBeNull();
    const revision = configService.revision;
    const identities = original.listRegisteredSchemaIdentities();
    expect(() => createSchemaRegistry({ configService })).toThrow(/already has/);
    expect(original.listRegisteredSchemaIdentities()).toEqual(identities);
    expect(write).not.toHaveBeenCalled();
    expect(configService.revision).toBe(revision);
  });

  test("keeps isolated schema-only fixture lookup semantics without promoting authority", async () => {
    const registry = createSchemaRegistry({ configService: {} });
    expect((await registry.register(registration())).success).toBe(true);
    expect(await registry.resolveAnchor("/svc")).toBeNull();
    expect(await registry.resolveAnchor("/svc", "dev")).not.toBeNull();
  });

  test("public protected writes remain denied after persistent binding and registration", async () => {
    const { provider, write } = providerWithEntries();
    const remove = vi.spyOn(provider, "remove");
    const configService = await service(provider);
    const registry = await createPersistentSchemaRegistry({ configService });
    expect((await registry.register(registration())).success).toBe(true);
    const persisted = await provider.load();
    const revision = configService.revision;
    for (const operation of [
      () => configService.set("platform", "_weaver.registry.schemas", {}),
      () => configService.remove("platform", "_weaver.registry.schemas"),
      () => configService.setMany("platform", { "_weaver.registry.schemas": {} }),
    ]) {
      expect((await operation()).success).toBe(false);
    }
    expect(write).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(await provider.load()).toEqual(persisted);
    expect(configService.revision).toBe(revision);
    expect(await configService.get("_weaver.registry.schemas")).toBeUndefined();
    expect(await registry.getSchema("svc", "dev")).toEqual(registration().schema);
  });

  test("legacy caller-provided registered-write registry cannot replace the bound authority", async () => {
    const { provider } = providerWithEntries();
    const configService = await service(provider);
    const bound = createSchemaRegistry({ configService });
    const caller = createSchemaRegistry({ configService: {} });
    expect((await caller.register(registration())).success).toBe(true);
    const revision = configService.revision;
    expect((await configService.setRegisteredObject("platform", "/svc", { name: "ok" }, {
      schemaRegistry: caller,
    })).error?.code).toBe("SCHEMA_NOT_REGISTERED");
    expect(bound.listAll()).toEqual({});
    expect(configService.revision).toBe(revision);
    expect((await provider.load()).entries.svc).toBeUndefined();
    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(/already has/);
    expect((await bound.register(registration())).success).toBe(true);
    expect((await configService.setRegisteredObject("platform", "/svc", { name: "ok" }, {
      schemaRegistry: caller,
    })).success).toBe(true);
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
