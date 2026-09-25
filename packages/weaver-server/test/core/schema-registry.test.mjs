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
    expect(await configService.get("_weaver.registry.schemas")).toEqual({
      environments: {
        dev: {
          schemas: {
            "/billing": {
              kind: "service",
              schema: {
                type: "object",
                properties: { enabled: { type: "boolean" } },
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
    });
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

  test("listAll includes hydrated persistent schemas", async () => {
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

    const registry = await createPersistentSchemaRegistry({ configService });

    expect(registry.listAll()).toEqual({ "/svc:prod": { type: "string" } });
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
