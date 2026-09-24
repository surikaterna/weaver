import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { ZodError } from "zod";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createPersistentSchemaRegistry } from "../../src/core/schema-registry.ts";
import {
  parsePersistedRegistry,
  serializeRegistry,
} from "../../src/core/schema-registry-persistence.ts";

const dangerousSegments = ["__proto__", "constructor", "prototype"];
const reservedEnvironments = ["__proto__", "constructor", "prototype"];

function persistedRegistryEntries(environmentRegistry, environment = "dev") {
  return {
    _weaver: {
      registry: {
        schemas: { environments: { [environment]: environmentRegistry } },
      },
    },
  };
}

function createTrackedProvider(initialEntries) {
  const provider = createInMemoryStorageProvider({
    id: "platform",
    layer: "platform",
    initialEntries,
  });
  const write = vi.spyOn(provider, "write");
  const writeLayer = vi.spyOn(provider, "writeLayer");
  return {
    provider,
    expectNoWrites() {
      expect(write).not.toHaveBeenCalled();
      expect(writeLayer).not.toHaveBeenCalled();
    },
  };
}

async function createPersistenceHarness(initialEntries) {
  const tracked = createTrackedProvider(initialEntries);
  const configService = await createWeaverConfigService({
    providers: [tracked.provider],
    environment: "dev",
  });
  return { ...tracked, configService };
}

async function configServiceWithRegistry(environmentRegistry) {
  const { configService } = await createPersistenceHarness(
    persistedRegistryEntries(environmentRegistry),
  );
  return configService;
}

describe("persistent schema registry hardening", () => {
  test("rejects reserved outer environment keys", () => {
    for (const environment of reservedEnvironments) {
      const environmentRegistry = schemaMetadataCase(
        "/billing",
        "environment",
        environment,
      );
      expect(() =>
        parsePersistedRegistry({
          environments: { [environment]: environmentRegistry },
        }),
      ).toThrow(ZodError);
    }
  });

  test("rejects reserved persisted environments before hydration effects", async () => {
    const originalPrototype = Object.getPrototypeOf({});
    const originalPrototypeProperties = Object.getOwnPropertyNames(
      Object.prototype,
    );
    for (const environment of reservedEnvironments) {
      for (const entries of reservedEnvironmentCases(environment)) {
        const harness = await createPersistenceHarness(entries);
        await expectReservedEnvironmentRejection(harness.configService);
        harness.expectNoWrites();
        expect(await harness.provider.load()).toEqual({ entries });
        expect(Object.getPrototypeOf({})).toBe(originalPrototype);
        expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(
          originalPrototypeProperties,
        );
      }
    }
  });

  test("remains usable after rejected hydration and valid restart", async () => {
    const malformed = await createPersistenceHarness(
      persistedRegistryEntries(
        schemaMetadataCase("/svc", "environment", "constructor"),
      ),
    );
    await expect(
      createPersistentSchemaRegistry({ configService: malformed.configService }),
    ).rejects.toBeInstanceOf(ZodError);
    malformed.expectNoWrites();

    const valid = await createPersistenceHarness({});
    const registry = await createPersistentSchemaRegistry({
      configService: valid.configService,
    });
    const result = await registry.register(serviceRegistration("staging"));
    expect(result.success).toBe(true);
    expect(Object.keys(registry.listAll())).toEqual(["/svc:staging"]);

    const restarted = await createPersistentSchemaRegistry({
      configService: valid.configService,
    });
    expect(await restarted.getSchema("svc", "staging")).toEqual({
      type: "object",
    });
  });

  test("serializes reserved dictionary keys as own properties", () => {
    const metadata = serviceMetadata("/svc", "constructor");
    const serialized = serializeRegistry({
      schemas: new Map([
        [
          "/svc:constructor",
          {
            kind: "service",
            path: "/svc",
            schema: { type: "object" },
            environment: "constructor",
            metadata,
          },
        ],
      ]),
      slots: new Map(),
    });

    expect(Object.hasOwn(serialized.environments, "constructor")).toBe(true);
    expect(serialized.environments.constructor.schemas["/svc"]).toEqual({
      kind: "service",
      schema: {
        encoding: "weaver.configuration-property-schema-graph",
        version: 1,
        root: 0,
        nodes: [{ type: "object" }],
      },
      metadata,
    });
  });

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

function serviceRegistration(environment) {
  return {
    serviceId: "svc",
    environment,
    owner: { name: "svc", contact: "svc@example.com" },
    schema: { type: "object" },
    fragmentSlots: [],
  };
}

function serviceMetadata(path, environment = "dev") {
  return {
    serviceId: "billing",
    servicePath: path,
    environment,
    providerId: "billing",
    owner: { name: "billing", contact: "billing@example.com" },
  };
}

function reservedEnvironmentCases(environment) {
  const servicePath = "/billing";
  const fragmentPath = "/billing/extensions/payments";
  return [
    persistedRegistryEntries(
      schemaMetadataCase(servicePath, "environment", environment),
    ),
    persistedRegistryEntries(
      fragmentMetadataCase(fragmentPath, "environment", environment),
    ),
    persistedRegistryEntries({
      schemas: {},
      slots: {
        "/billing/extensions": slotMetadataCase(
          "/billing/extensions",
          "environment",
          environment,
        ).slots["/billing/extensions"],
      },
    }),
  ];
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

async function expectReservedEnvironmentRejection(configService) {
  try {
    await createPersistentSchemaRegistry({ configService });
    throw new Error("Expected persisted environment rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Environment uses a reserved identifier",
        }),
      ]),
    );
  }
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
