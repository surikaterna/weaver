import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import {
  fragmentSchemaRegistrationRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "@weaver-conf/config-types";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import {
  createPersistentSchemaRegistry,
  createSchemaRegistry,
} from "../../src/core/schema-registry.ts";
import {
  parsePersistedRegistry,
  serializeRegistry,
} from "@weaver-conf/config-registry/persistence";

const owner = { name: "test", contact: "test@example.org" };
const service = (environment, slotPath) =>
  serviceSchemaRegistrationRequestSchema.parse({
    serviceId: "svc", environment, owner, schema: { type: "object" },
    fragmentSlots: [{ slotPath, accepts: "object" }],
  });
const fragment = (environment, slotPath, providerId) =>
  fragmentSchemaRegistrationRequestSchema.parse({
    serviceId: "svc", environment, owner, schema: { type: "object" },
    slotPath, providerId,
  });

async function harness(initialEntries = {}) {
  const provider = createInMemoryStorageProvider({
    id: "platform", layer: "platform", initialEntries,
  });
  const configService = await createWeaverConfigService({
    providers: [provider], environment: "default",
  });
  return { provider, configService };
}

async function restartedRegistry(provider) {
  const configService = await createWeaverConfigService({
    providers: [provider], environment: "default",
  });
  return createPersistentSchemaRegistry({ configService });
}

const fragments = [
  fragment("prod/dev:x", "/plugins", "p"),
  fragment("x", "/plugins/p:prod", "dev"),
];
const fragmentPaths = ["/svc/plugins/p", "/svc/plugins/p:prod/dev"];

for (const persistent of [false, true]) {
  for (const reverse of [false, true]) {
    test(`fragment tuple collision ${persistent ? "persistent" : "transient"} reverse=${reverse}`, async () => {
      const { configService, provider } = await harness();
      const registry = persistent
        ? await createPersistentSchemaRegistry({ configService })
        : createSchemaRegistry({ configService });
      for (const request of [service("prod/dev:x", "/plugins"), service("x", "/plugins/p:prod")]) {
        expect((await registry.register(request)).success).toBe(true);
      }
      for (const request of reverse ? [...fragments].reverse() : fragments) {
        expect((await registry.register(request)).success).toBe(true);
      }
      const check = async (subject) => {
        for (const [index, request] of fragments.entries()) {
          const path = fragmentPaths[index];
          expect(subject.getRegisteredSchema(path, request.environment)).toMatchObject({
            path, environment: request.environment, kind: "fragment",
          });
          expect(await subject.resolveAnchor(path, request.environment)).toMatchObject({ path });
        }
        expect(subject.listRegisteredSchemaIdentities().anchors).toHaveLength(4);
        expect(() => subject.listAll()).toThrow(expect.objectContaining({ code: "SCHEMA_CONFLICT" }));
      };
      await check(registry);
      if (persistent) {
        expect((await provider.load()).entries._weaver.registry.schemas.version).toBe(2);
        await check(await restartedRegistry(provider));
      }
    });
  }
}

for (const persistent of [false, true]) {
  test(`slot tuples remain independent ${persistent ? "persistently" : "transiently"}`, async () => {
    const { configService, provider } = await harness();
    const registry = persistent
      ? await createPersistentSchemaRegistry({ configService })
      : createSchemaRegistry({ configService });
    const first = service("prod:dev", "/plugins");
    const second = service("dev", "/plugins:prod");
    expect((await registry.register(first)).success).toBe(true);
    expect((await registry.register(second)).success).toBe(true);
    const restart = async () => persistent
      ? restartedRegistry(provider) : registry;
    expect((await restart()).listRegisteredSchemaIdentities().slots).toHaveLength(2);
    expect((await registry.register({ ...first, fragmentSlots: [] })).success).toBe(true);
    const missing = fragment("prod:dev", "/plugins", "p");
    expect((await registry.register(missing)).error?.message).toContain("Unknown fragment slot");
    const admitted = fragment("dev", "/plugins:prod", "p");
    expect((await registry.register(admitted)).success).toBe(true);
    expect((await registry.register({ ...second, fragmentSlots: [] })).error?.message)
      .toContain("Cannot remove fragment slot");
    const recovered = await restart();
    expect(recovered.listRegisteredSchemaIdentities().slots).toMatchObject([
      { path: "/svc/plugins:prod", environment: "dev" },
    ]);
    expect((await recovered.register(missing)).success).toBe(false);
    expect(recovered.getRegisteredSchema("/svc/plugins:prod/p", "dev")).not.toBeNull();
  });
}

test("legacy grouped collisions hydrate without aliasing and upgrade only after successful write", async () => {
  const { configService, provider } = await harness();
  const original = await createPersistentSchemaRegistry({ configService });
  for (const request of [service("prod/dev:x", "/plugins"), service("x", "/plugins/p:prod"), ...fragments]) {
    expect((await original.register(request)).success).toBe(true);
  }
  const v2 = (await provider.load()).entries._weaver.registry.schemas;
  const legacy = { environments: v2.environments };
  const restored = await harness({ _weaver: { registry: { schemas: legacy } } });
  const hydrated = await createPersistentSchemaRegistry({ configService: restored.configService });
  expect((await restored.provider.load()).entries._weaver.registry.schemas).toEqual(legacy);
  expect(hydrated.listRegisteredSchemaIdentities().anchors).toHaveLength(4);
  expect(() => hydrated.listAll()).toThrow(expect.objectContaining({ code: "SCHEMA_CONFLICT" }));
  expect((await hydrated.register(service("x", "/plugins/p:prod"))).success).toBe(true);
  expect((await restored.provider.load()).entries._weaver.registry.schemas.version).toBe(2);
  expect((await restartedRegistry(restored.provider))
    .listRegisteredSchemaIdentities().anchors).toHaveLength(4);
  const state = parsePersistedRegistry(legacy);
  expect(state.schemas.size).toBe(4);
  expect(state.slots.size).toBe(2);
  expect(serializeRegistry(state).version).toBe(2);
  const lonePath = fragmentPaths[1];
  const lone = { environments: { x: {
    schemas: { [lonePath]: v2.environments.x.schemas[lonePath] },
    slots: {},
  } } };
  expect(parsePersistedRegistry(lone).schemas.size).toBe(1);
  for (const malformed of [
    { version: 3, environments: {} },
    { version: 2, environments: {}, extra: true },
    { environments: { x: { schemas: { "/svc": { kind: "service", schema: { type: "object" }, metadata: { ...v2.environments.x.schemas["/svc"].metadata, environment: "wrong" } } }, slots: {} } } },
  ]) {
    expect(() => parsePersistedRegistry(malformed)).toThrow();
  }
});

test("a failed v1 upgrade write leaves the hydrated identities and stored bytes unchanged", async () => {
  const first = await harness();
  const initial = await createPersistentSchemaRegistry({ configService: first.configService });
  expect((await initial.register(service("prod:dev", "/plugins"))).success).toBe(true);
  const v2 = (await first.provider.load()).entries._weaver.registry.schemas;
  const legacy = { _weaver: { registry: { schemas: { environments: v2.environments } } } };
  const provider = createInMemoryStorageProvider({
    id: "platform", layer: "platform", initialEntries: legacy,
  });
  const configService = await createWeaverConfigService({ providers: [provider], environment: "default" });
  const registry = await createPersistentSchemaRegistry({ configService });
  provider.write = async () => ({ success: false, error: { code: "INTERNAL_ERROR", message: "injected" } });
  const before = registry.listRegisteredSchemaIdentities();
  const cursor = registry.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor;
  expect((await registry.register(service("dev", "/plugins:prod"))).success).toBe(false);
  expect(registry.listRegisteredSchemaIdentityPage({ cursor }).anchors.length + registry.listRegisteredSchemaIdentityPage({ cursor }).slots.length).toBe(1);
  expect(registry.listRegisteredSchemaIdentities()).toEqual(before);
  expect((await provider.load()).entries).toEqual(legacy);
  expect((await restartedRegistry(provider)).listRegisteredSchemaIdentities()).toEqual(before);
});
