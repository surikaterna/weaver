import {
  createPersistentSchemaRegistry,
  createSchemaRegistry,
} from "../../src/core/schema-registry.ts";
import { createWeaverConfigService } from "../../src/core/config-service.ts";

function deepSet(target, path, value) {
  const parts = path.split(".");
  let current = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    current[part] = current[part] ?? {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function createTestProvider(id, layer, entries) {
  let data = { ...entries };
  return {
    id,
    layer,
    writable: true,
    async load() { return { entries: { ...data } }; },
    async write(key, value) { deepSet(data, key, value); return { success: true }; },
    async remove(key) { delete data[key]; return { success: true }; },
  };
}

function createFailingProvider(id, layer) {
  return {
    id,
    layer,
    writable: true,
    async load() { return { entries: {} }; },
    async write() {
      return { success: false, error: { code: "INTERNAL_ERROR", message: "nope" } };
    },
    async remove() { return { success: true }; },
  };
}

function makeOptions() {
  const provider = createTestProvider("p1", "platform", {});
  return createWeaverConfigService({
    providers: [provider],
    environment: "dev",
  }).then((configService) => ({
    configService,
  }));
}

function serviceRegistration(serviceId, environment, schema) {
  return {
    serviceId,
    environment,
    owner: { name: serviceId, contact: `${serviceId}@example.com` },
    schema,
    fragmentSlots: [],
  };
}

function persistedRegistryEntries(environmentRegistry) {
  return {
    _weaver: {
      registry: {
        schemas: { environments: { dev: environmentRegistry } },
      },
    },
  };
}

describe("SchemaRegistry", () => {
  test("register new schema succeeds with isNewSchema true", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);

    const result = await registry.register({
      ...serviceRegistration("my-service", "dev", {
        type: "object",
        properties: { port: { type: "number", default: 3000 } },
      }),
    });

    expect(result.success).toBe(true);
    expect(result.isNewSchema).toBe(true);
    expect(result.hasBreakingChanges).toBe(false);
  });

  test("register unchanged schema is idempotent", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);
    const schema = { type: "object", properties: { port: { type: "number" } } };

    await registry.register(serviceRegistration("svc", "dev", schema));
    const result = await registry.register(serviceRegistration("svc", "dev", schema));

    expect(result.success).toBe(true);
    expect(result.isNewSchema).toBe(false);
    expect(result.hasBreakingChanges).toBe(false);
  });

  test("register rejects non-object and ambiguous service schema roots", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);
    const invalidSchemas = [
      { type: "string" },
      { type: "array", items: { type: "string" } },
      { properties: { enabled: { type: "boolean" } } },
      { oneOf: [{ type: "object" }, { type: "string" }] },
      { type: ["object", "null"] },
    ];

    for (const schema of invalidSchemas) {
      const result = await registry.register(serviceRegistration("svc", "dev", schema));
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('type exactly "object"');
    }
    expect(registry.listAll()).toEqual({});
  });

  test("register rejects non-object and ambiguous fragment schema roots", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);
    await registry.register({
      ...serviceRegistration("svc", "dev", { type: "object" }),
      fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
    });

    for (const schema of [{ type: "string" }, { type: ["object", "null"] }]) {
      const result = await registry.register({
        serviceId: "svc",
        providerId: "plugin",
        slotPath: "/plugins",
        environment: "dev",
        owner: { name: "plugin", contact: "plugin@example.com" },
        schema,
      });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('type exactly "object"');
    }
    expect(Object.keys(registry.listAll())).toEqual(["/svc:dev"]);
  });

  test("register with removed property detects breaking change", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);

    await registry.register({
      ...serviceRegistration("svc", "dev", {
        type: "object",
        properties: { port: { type: "number" }, host: { type: "string" } },
      }),
    });

    const result = await registry.register({
      ...serviceRegistration("svc", "dev", {
        type: "object",
        properties: { port: { type: "number" } },
      }),
    });

    expect(result.success).toBe(true);
    expect(result.hasBreakingChanges).toBe(true);
    expect(result.breakingChanges?.some((c) => c.includes("host"))).toBeTruthy();
  });

  test("getSchema returns registered schema", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);
    const schema = { type: "object", properties: { key: { type: "string" } } };

    await registry.register(serviceRegistration("svc", "dev", schema));
    const registeredSchema = await registry.getSchema("svc", "dev");

    expect(registeredSchema).toEqual(schema);
  });

  test("getSchema returns null for unknown service", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);

    const schema = await registry.getSchema("unknown", "dev");
    expect(schema).toBe(null);
  });

  test("persistent registry writes schemas into the protected internal registry root", async () => {
    const provider = createTestProvider("p1", "custom", {});
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });
    const registry = await createPersistentSchemaRegistry({
      configService,
      layer: "custom",
    });

    const result = await registry.register({
      ...serviceRegistration("billing", "dev", {
        type: "object",
        properties: { enabled: { type: "boolean" } },
      }),
    });

    expect(result.success).toBe(true);
    expect(await configService.get("_weaver.registry.schemas")).toBe(undefined);

    const restartedService = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });
    const restartedRegistry = await createPersistentSchemaRegistry({
      configService: restartedService,
      layer: "custom",
    });
    expect(await restartedRegistry.getSchema("billing", "dev")).toEqual({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    });
    await expect(restartedService.get("billing")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { anchorPath: "/billing" },
    });
    const completed = await restartedService.set("custom", "billing.enabled", true);
    expect(completed.success).toBe(true);
    expect(await restartedService.get("billing")).toEqual({ enabled: true });
  });

  test("internal registry persistence does not emit public config deltas", async () => {
    const opts = await makeOptions();
    const deltas = [];
    opts.configService.onDelta((delta) => deltas.push(delta));
    const registry = await createPersistentSchemaRegistry(opts);

    await registry.register(
      serviceRegistration("billing", "dev", { type: "object" }),
    );

    expect(deltas).toEqual([]);
  });

  test("persistent registry hydrates schemas after restart", async () => {
    const entries = {
      _weaver: {
        registry: {
          schemas: {
            environments: {
              dev: {
                schemas: {
                  "/billing": {
                    kind: "service",
                    schema: {
                      type: "object",
                      properties: { limit: { type: "number" } },
                    },
                    metadata: {
                      serviceId: "billing",
                      servicePath: "/billing",
                      environment: "dev",
                      providerId: "billing",
                      owner: { name: "billing", contact: "billing@example.com" },
                    },
                  },
                },
                slots: {},
              },
            },
          },
        },
      },
    };
    const configService = await createWeaverConfigService({
      providers: [createTestProvider("p1", "platform", entries)],
      environment: "dev",
    });

    const registry = await createPersistentSchemaRegistry({ configService });

    expect(await registry.getSchema("billing", "dev")).toEqual({
      type: "object",
      properties: { limit: { type: "number" } },
    });
  });

  test("persistent registry rejects non-object service schema roots", async () => {
    const configService = await createWeaverConfigService({
      providers: [
        createTestProvider("p1", "platform", {
          _weaver: {
            registry: {
              schemas: {
                environments: {
                  prod: {
                    schemas: {
                      "/svc": {
                        kind: "service",
                        schema: { type: "string" },
                        metadata: {
                          serviceId: "svc",
                          servicePath: "/svc",
                          environment: "prod",
                          providerId: "svc",
                          owner: { name: "svc", contact: "svc@example.com" },
                        },
                      },
                    },
                    slots: {},
                  },
                },
              },
            },
          },
        }),
      ],
      environment: "prod",
    });

    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow();
  });

  test("persistent registry rejects non-object fragment schema roots", async () => {
    const path = "/billing/extensions/payments";
    const environmentRegistry = fragmentMetadataCase(path, "schemaVersion", "1.0.0");
    environmentRegistry.schemas[path].schema = { type: ["object", "null"] };
    const configService = await createWeaverConfigService({
      providers: [createTestProvider("p1", "platform", persistedRegistryEntries(environmentRegistry))],
      environment: "dev",
    });

    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow();
  });

  test("persistent registry throws for invalid persisted root", async () => {
    const configService = await createWeaverConfigService({
      providers: [
        createTestProvider("p1", "platform", {
          _weaver: { registry: { schemas: [] } },
        }),
      ],
      environment: "dev",
    });

    await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(/Persisted schema registry must be an object/);
  });

  test("persistent registry rejects dangerous schema and slot paths without changing prototypes", async () => {
    Reflect.deleteProperty(Object.prototype, "polluted");
    try {
      for (const segment of ["__proto__", "constructor", "prototype"]) {
        const path = `/billing/${segment}`;
        const schemaEntry = {
          kind: "service",
          schema: { type: "object" },
          metadata: {
            serviceId: "billing",
            servicePath: path,
            environment: "dev",
            providerId: "billing",
            owner: { name: "billing", contact: "billing@example.com" },
          },
        };
        const slot = {
          serviceId: "billing",
          servicePath: "/billing",
          slotPath: `/${segment}`,
          canonicalSlotPath: path,
          environment: "dev",
          providerId: "billing",
          owner: { name: "billing", contact: "billing@example.com" },
          accepts: "object",
        };

        for (const environmentRegistry of [
          { schemas: { [path]: schemaEntry }, slots: {} },
          { schemas: {}, slots: { [path]: slot } },
        ]) {
          const configService = await createWeaverConfigService({
            providers: [createTestProvider("p1", "platform", persistedRegistryEntries(environmentRegistry))],
            environment: "dev",
          });
          await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(
            `Path segment "${segment}" is not allowed`,
          );
        }
      }
      expect(Reflect.get(Object.prototype, "polluted")).toBe(undefined);
    } finally {
      Reflect.deleteProperty(Object.prototype, "polluted");
    }
  });

  test("persistent registry rejects dangerous path metadata behind safe keys", async () => {
    Reflect.deleteProperty(Object.prototype, "polluted");
    const servicePath = "/billing";
    const slotPath = "/extensions";
    const canonicalSlotPath = `${servicePath}${slotPath}`;
    const fragmentPath = `${canonicalSlotPath}/payments`;
    try {
      for (const segment of ["__proto__", "constructor", "prototype"]) {
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
          await expectPersistedRegistryRejection(environmentRegistry, segment);
        }
      }
      expect(Reflect.get(Object.prototype, "polluted")).toBe(undefined);
    } finally {
      Reflect.deleteProperty(Object.prototype, "polluted");
    }
  });

  test("register rejects legacy target fields", async () => {
    const opts = await makeOptions();
    const registry = createSchemaRegistry(opts);

    const result = await registry.register({
      ...serviceRegistration("svc", "dev", { type: "object" }),
      path: "/svc",
      namespace: "legacy",
      ownerId: "team-a",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
  });

  test("write failure returns failed result without updating memory", async () => {
    const configService = await createWeaverConfigService({
      providers: [createFailingProvider("p1", "platform")],
      environment: "dev",
    });
    const registry = await createPersistentSchemaRegistry({ configService });

    const result = await registry.register({
      ...serviceRegistration("svc", "dev", {
        type: "object",
        properties: { host: { type: "string" } },
      }),
    });

    expect(result.success).toBe(false);
    expect(await registry.getSchema("svc", "dev")).toBe(null);
    expect(registry.listAll()).toEqual({});
  });
});

function schemaMetadataCase(path, field, value) {
  const metadata = {
    serviceId: "billing",
    servicePath: path,
    environment: "dev",
    providerId: "billing",
    owner: { name: "billing", contact: "billing@example.com" },
    [field]: value,
  };
  return { schemas: { [path]: { kind: "service", schema: { type: "object" }, metadata } }, slots: {} };
}

function fragmentMetadataCase(path, field, value) {
  const metadata = {
    serviceId: "billing",
    servicePath: "/billing",
    canonicalSlotPath: "/billing/extensions",
    fragmentPath: path,
    environment: "dev",
    providerId: "payments",
    owner: { name: "payments", contact: "payments@example.com" },
    [field]: value,
  };
  return { schemas: { [path]: { kind: "fragment", schema: { type: "object" }, metadata } }, slots: {} };
}

function slotMetadataCase(path, field, value) {
  const slot = {
    serviceId: "billing",
    servicePath: "/billing",
    slotPath: "/extensions",
    canonicalSlotPath: path,
    environment: "dev",
    providerId: "billing",
    owner: { name: "billing", contact: "billing@example.com" },
    accepts: "object",
    [field]: value,
  };
  return { schemas: {}, slots: { [path]: slot } };
}

async function expectPersistedRegistryRejection(environmentRegistry, segment) {
  const configService = await createWeaverConfigService({
    providers: [createTestProvider("p1", "platform", persistedRegistryEntries(environmentRegistry))],
    environment: "dev",
  });
  await expect(createPersistentSchemaRegistry({ configService })).rejects.toThrow(
    `Path segment "${segment}" is not allowed`,
  );
}
