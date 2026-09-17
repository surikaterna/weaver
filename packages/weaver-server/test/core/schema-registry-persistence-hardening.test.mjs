import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createPersistentSchemaRegistry } from "../../src/core/schema-registry.ts";

const dangerousSegments = ["__proto__", "constructor", "prototype"];

function persistedRegistryEntries(environmentRegistry) {
  return {
    _weaver: {
      registry: {
        schemas: { environments: { dev: environmentRegistry } },
      },
    },
  };
}

async function configServiceWithRegistry(environmentRegistry) {
  return createWeaverConfigService({
    providers: [
      createInMemoryStorageProvider({
        id: "platform",
        layer: "platform",
        initialEntries: persistedRegistryEntries(environmentRegistry),
      }),
    ],
    environment: "dev",
  });
}

describe("persistent schema registry hardening", () => {
  test("rejects non-object service and fragment roots during hydration", async () => {
    const serviceRegistry = schemaMetadataCase("/svc", "schemaVersion", "1");
    serviceRegistry.schemas["/svc"].schema = { type: "string" };
    const fragmentPath = "/billing/extensions/payments";
    const fragmentRegistry = fragmentMetadataCase(
      fragmentPath,
      "schemaVersion",
      "1",
    );
    fragmentRegistry.schemas[fragmentPath].schema = {
      type: ["object", "null"],
    };

    for (const environmentRegistry of [serviceRegistry, fragmentRegistry]) {
      const configService = await configServiceWithRegistry(
        environmentRegistry,
      );
      await expect(
        createPersistentSchemaRegistry({ configService }),
      ).rejects.toThrow();
    }
  });

  test("rejects non-object registrations before persistence or restart state", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });
    const registry = await createPersistentSchemaRegistry({ configService });

    for (const schema of [
      { type: "string" },
      { type: ["object", "null"] },
      { properties: { enabled: { type: "boolean" } } },
    ]) {
      const result = await registry.register({
        serviceId: "svc",
        environment: "dev",
        owner: { name: "svc", contact: "svc@example.com" },
        schema,
        fragmentSlots: [],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("VALIDATION_ERROR");
    }

    expect(registry.listAll()).toEqual({});
    expect(await configService.get("_weaver.registry.schemas")).toBeUndefined();
    const restarted = await createPersistentSchemaRegistry({ configService });
    expect(restarted.listAll()).toEqual({});
  });

  test("rejects dangerous schema and slot keys without prototype changes", async () => {
    await withoutPrototypePollution(async () => {
      for (const segment of dangerousSegments) {
        const path = `/billing/${segment}`;
        const schemaEntry = {
          kind: "service",
          schema: { type: "object" },
          metadata: serviceMetadata(path),
        };
        const slot = slotMetadata(path, `/${segment}`);

        for (const environmentRegistry of [
          { schemas: { [path]: schemaEntry }, slots: {} },
          { schemas: {}, slots: { [path]: slot } },
        ]) {
          await expectPersistedRegistryRejection(
            environmentRegistry,
            segment,
          );
        }
      }
    });
  });

  test("rejects dangerous path metadata behind safe keys", async () => {
    await withoutPrototypePollution(async () => {
      const servicePath = "/billing";
      const canonicalSlotPath = "/billing/extensions";
      const fragmentPath = `${canonicalSlotPath}/payments`;
      for (const segment of dangerousSegments) {
        const dangerousPath = `/billing/${segment}`;
        const cases = [
          schemaMetadataCase(servicePath, "servicePath", dangerousPath),
          schemaMetadataCase(servicePath, "canonicalSlotPath", dangerousPath),
          schemaMetadataCase(servicePath, "fragmentPath", dangerousPath),
          fragmentMetadataCase(fragmentPath, "servicePath", dangerousPath),
          fragmentMetadataCase(fragmentPath, "canonicalSlotPath", dangerousPath),
          fragmentMetadataCase(fragmentPath, "fragmentPath", dangerousPath),
          slotMetadataCase(canonicalSlotPath, "servicePath", dangerousPath),
          slotMetadataCase(canonicalSlotPath, "slotPath", `/${segment}`),
          slotMetadataCase(canonicalSlotPath, "canonicalSlotPath", dangerousPath),
        ];

        for (const environmentRegistry of cases) {
          await expectPersistedRegistryRejection(
            environmentRegistry,
            segment,
          );
        }
      }
    });
  });
});

function serviceMetadata(path) {
  return {
    serviceId: "billing",
    servicePath: path,
    environment: "dev",
    providerId: "billing",
    owner: { name: "billing", contact: "billing@example.com" },
  };
}

function slotMetadata(path, slotPath = "/extensions") {
  return {
    ...serviceMetadata("/billing"),
    slotPath,
    canonicalSlotPath: path,
    accepts: "object",
  };
}

function schemaMetadataCase(path, field, value) {
  const metadata = { ...serviceMetadata(path), [field]: value };
  return {
    schemas: {
      [path]: { kind: "service", schema: { type: "object" }, metadata },
    },
    slots: {},
  };
}

function fragmentMetadataCase(path, field, value) {
  const metadata = {
    ...serviceMetadata("/billing"),
    canonicalSlotPath: "/billing/extensions",
    fragmentPath: path,
    providerId: "payments",
    owner: { name: "payments", contact: "payments@example.com" },
    [field]: value,
  };
  return {
    schemas: {
      [path]: { kind: "fragment", schema: { type: "object" }, metadata },
    },
    slots: {},
  };
}

function slotMetadataCase(path, field, value) {
  const slot = { ...slotMetadata(path), [field]: value };
  return { schemas: {}, slots: { [path]: slot } };
}

async function expectPersistedRegistryRejection(environmentRegistry, segment) {
  const configService = await configServiceWithRegistry(environmentRegistry);
  await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(
    `Path segment "${segment}" is not allowed`,
  );
}

async function withoutPrototypePollution(run) {
  Reflect.deleteProperty(Object.prototype, "polluted");
  try {
    await run();
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  } finally {
    Reflect.deleteProperty(Object.prototype, "polluted");
  }
}
