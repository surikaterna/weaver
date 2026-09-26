import type {
  ConfigurationPropertySchema,
  ConfigurationStorageProvider,
} from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import type { WeaverConfigService } from "../src/core/config-service.js";
import { createWeaverConfigService } from "../src/core/config-service.js";
import {
  createPersistentSchemaRegistry,
  createSchemaRegistry,
} from "../src/core/schema-registry.js";

const configService = {} as WeaverConfigService;

const prototypeUnsafeEnvironments = [
  "__proto__",
  "constructor",
  "prototype",
] as const;

function serviceRegistration(environment = "default") {
  return {
    serviceId: "example-service",
    environment,
    owner: {
      name: "Example Service",
      contact: "example-service@example.com",
    },
    schema: { type: "object" as const },
    schemaVersion: "1.2.3",
    fragmentSlots: [{ slotPath: "/plugins", accepts: "object" as const }],
  };
}

function createCountingProvider() {
  let mutationCount = 0;
  const provider: ConfigurationStorageProvider = {
    id: "platform",
    layer: "platform",
    writable: true,
    async load() {
      return { entries: {} };
    },
    async write() {
      mutationCount++;
      return { success: true };
    },
    async remove() {
      mutationCount++;
      return { success: true };
    },
  };
  return { provider, mutationCount: () => mutationCount };
}

function fragmentRegistration(providerId = "ghost.settings.panel") {
  return {
    serviceId: "example-service",
    providerId,
    slotPath: "/plugins",
    environment: "default",
    owner: { name: "Ghost", contact: "ghost@example.com" },
    schema: { type: "object" as const },
    schemaVersion: "0.4.0",
  };
}

function compositionSchema(): ConfigurationPropertySchema {
  const branches: ConfigurationPropertySchema[] = [
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "text" },
        value: { type: "string" },
      },
      additionalProperties: true,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "count" },
        value: { type: "number" },
      },
      additionalProperties: true,
    },
  ];
  return {
    type: "object",
    required: ["kind", "value"],
    properties: {
      kind: { type: "string" },
      value: { type: ["string", "number"] },
      nested: {
        type: "string",
        anyOf: [{ type: "string", minLength: 1 }],
        oneOf: [{ type: "string", maxLength: 20 }],
        allOf: [{ type: "string", pattern: "^[a-z]+$" }],
        not: { type: "string", const: "blocked" },
      },
    },
    additionalProperties: false,
    anyOf: branches,
    oneOf: branches,
    allOf: [{ type: "object", maxProperties: 3, additionalProperties: true }],
    not: {
      type: "object",
      const: { kind: "blocked", value: "blocked" },
      additionalProperties: true,
    },
  };
}

describe("SchemaRegistry", () => {
  it("preserves supported composition in transient service and fragment registrations", async () => {
    const registry = createSchemaRegistry({ configService });
    const schema = compositionSchema();
    const service = await registry.register({
      ...serviceRegistration(),
      schema,
    });
    const fragment = await registry.register({
      ...fragmentRegistration(),
      schema,
    });

    expect(service.success).toBe(true);
    expect(fragment.success).toBe(true);
    expect(await registry.getSchema("example-service", "default")).toEqual(
      schema,
    );
    expect(
      (
        await registry.resolveAnchor(
          "/example-service/plugins/ghost.settings.panel",
          "default",
        )
      )?.schema,
    ).toEqual(schema);
  });

  it("hydrates exact composition and uses it for registered writes after restart", async () => {
    const persistentConfigService = await createWeaverConfigService({
      providers: [
        createInMemoryStorageProvider({
          id: "platform",
          layer: "platform",
          initialEntries: {},
        }),
      ],
      environment: "default",
    });
    const registry = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    const schema = compositionSchema();
    expect(
      (
        await registry.register({
          ...serviceRegistration(),
          schema,
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await registry.register({
          ...fragmentRegistration(),
          schema,
        })
      ).success,
    ).toBe(true);

    const restarted = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    expect(await restarted.getSchema("example-service", "default")).toEqual(
      schema,
    );
    expect(
      (
        await restarted.resolveAnchor(
          "/example-service/plugins/ghost.settings.panel",
          "default",
        )
      )?.schema,
    ).toEqual(schema);

    expect(
      await persistentConfigService.setRegisteredObject(
        "platform",
        "/example-service",
        { kind: "text", value: "old", nested: "safe" },
        { schemaRegistry: restarted },
      ),
    ).toEqual({ success: true });
    expect(
      await persistentConfigService.patchRegisteredPath(
        "platform",
        "/example-service/value",
        "new",
        { schemaRegistry: restarted },
      ),
    ).toEqual({ success: true });
    expect(
      await persistentConfigService.validateRegisteredEffective(
        "/example-service",
        { schemaRegistry: restarted },
      ),
    ).toEqual({ valid: true, errors: [] });
  });

  it("registers service schema metadata with owner, version, and derived paths", async () => {
    const registry = createSchemaRegistry({ configService });
    const result = await registry.register(serviceRegistration(), {
      subject: "svc:example-service",
      actor: "api",
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toEqual({
      serviceId: "example-service",
      servicePath: "/example-service",
      environment: "default",
      providerId: "example-service",
      owner: {
        name: "Example Service",
        contact: "example-service@example.com",
      },
      schemaVersion: "1.2.3",
      audit: { subject: "svc:example-service", actor: "api" },
    });
    expect(await registry.getSchema("example-service", "default")).toEqual({
      type: "object",
    });
    expect(Object.keys(registry.listAll())).toEqual([
      "/example-service:default",
    ]);
  });

  it("registers fragment schema metadata under a declared slot", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());
    const result = await registry.register(fragmentRegistration());

    expect(result.success).toBe(true);
    expect(result.metadata).toEqual({
      serviceId: "example-service",
      servicePath: "/example-service",
      canonicalSlotPath: "/example-service/plugins",
      providerId: "ghost.settings.panel",
      fragmentPath: "/example-service/plugins/ghost.settings.panel",
      environment: "default",
      owner: { name: "Ghost", contact: "ghost@example.com" },
      schemaVersion: "0.4.0",
    });
    expect(Object.keys(registry.listAll())).toEqual([
      "/example-service:default",
      "/example-service/plugins/ghost.settings.panel:default",
    ]);
  });

  it("rejects fragments for unknown slots", async () => {
    const registry = createSchemaRegistry({ configService });
    const result = await registry.register(fragmentRegistration());

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Unknown fragment slot");
  });

  it("rejects duplicate fragment paths in one environment", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());
    expect((await registry.register(fragmentRegistration())).success).toBe(
      true,
    );

    const duplicate = await registry.register(fragmentRegistration());

    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.message).toContain(
      "Duplicate fragment registration",
    );
  });

  it("treats service fragmentSlots as authoritative on re-registration", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());

    const removal = await registry.register({
      ...serviceRegistration(),
      fragmentSlots: [],
    });
    const fragment = await registry.register(fragmentRegistration());

    expect(removal.success).toBe(true);
    expect(fragment.success).toBe(false);
    expect(fragment.error?.message).toContain("Unknown fragment slot");
  });

  it("rejects slot removal while fragments exist in that slot", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());
    await registry.register(fragmentRegistration());

    const removal = await registry.register({
      ...serviceRegistration(),
      fragmentSlots: [],
    });

    expect(removal.success).toBe(false);
    expect(removal.error?.message).toContain("Cannot remove fragment slot");
  });

  it("rejects invalid provider ids and protected service paths", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());

    expect(
      (await registry.register(fragmentRegistration("bad/id"))).success,
    ).toBe(false);
    expect(
      (
        await registry.register({
          ...serviceRegistration(),
          serviceId: "_weaver",
          owner: { name: "Internal", contact: "platform@example.com" },
          fragmentSlots: [],
        })
      ).success,
    ).toBe(false);
  });

  it("rejects prototype-unsafe environments without transient mutation", async () => {
    const registry = createSchemaRegistry({ configService });

    for (const environment of prototypeUnsafeEnvironments) {
      const result = await registry.register(serviceRegistration(environment));
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("VALIDATION_ERROR");
    }

    expect(registry.listAll()).toEqual({});
  });

  it("rejects prototype-unsafe environments before persistent effects", async () => {
    const { provider, mutationCount } = createCountingProvider();
    const persistentConfigService = await createWeaverConfigService({
      providers: [provider],
      environment: "default",
    });
    const registry = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    const objectPrototype = Object.getPrototypeOf({});

    for (const environment of prototypeUnsafeEnvironments) {
      const result = await registry.register(serviceRegistration(environment));
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("VALIDATION_ERROR");
    }

    expect(registry.listAll()).toEqual({});
    expect(mutationCount()).toBe(0);
    expect(await persistentConfigService.get("_weaver.registry.schemas")).toBe(
      undefined,
    );
    expect(Object.getPrototypeOf({})).toBe(objectPrototype);

    const restarted = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    expect(restarted.listAll()).toEqual({});
  });

  it("persists and hydrates registry metadata under the protected internal root", async () => {
    const persistentConfigService = await createWeaverConfigService({
      providers: [
        createInMemoryStorageProvider({
          id: "platform",
          layer: "platform",
          initialEntries: {},
        }),
      ],
      environment: "default",
    });

    const registry = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    await registry.register(serviceRegistration(), { actor: "api" });

    expect(
      await persistentConfigService.get("_weaver.registry.schemas"),
    ).toEqual({
      environments: {
        default: {
          schemas: {
            "/example-service": {
              kind: "service",
              schema: {
                encoding: "weaver.configuration-property-schema-graph",
                version: 1,
                root: 0,
                nodes: [{ type: "object" }],
              },
              metadata: {
                serviceId: "example-service",
                servicePath: "/example-service",
                environment: "default",
                providerId: "example-service",
                owner: {
                  name: "Example Service",
                  contact: "example-service@example.com",
                },
                schemaVersion: "1.2.3",
                audit: { actor: "api" },
              },
            },
          },
          slots: {
            "/example-service/plugins": {
              serviceId: "example-service",
              servicePath: "/example-service",
              slotPath: "/plugins",
              canonicalSlotPath: "/example-service/plugins",
              environment: "default",
              providerId: "example-service",
              owner: {
                name: "Example Service",
                contact: "example-service@example.com",
              },
              accepts: "object",
              schemaVersion: "1.2.3",
              audit: { actor: "api" },
            },
          },
        },
      },
    });

    const hydrated = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    expect((await hydrated.register(fragmentRegistration())).success).toBe(
      true,
    );
    expect(Object.keys(hydrated.listAll())).toContain(
      "/example-service/plugins/ghost.settings.panel:default",
    );
  });

  it("resolves omitted environments through the persistent registry default", async () => {
    const persistentConfigService = await createWeaverConfigService({
      providers: [
        createInMemoryStorageProvider({
          id: "platform",
          layer: "platform",
          initialEntries: {},
        }),
      ],
      environment: "default",
    });
    const registry = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
      environment: "default",
    });
    await registry.register(serviceRegistration());

    expect(
      (await registry.resolveAnchor("/example-service"))?.environment,
    ).toBe("default");
    expect(
      await registry.resolveAnchor("/example-service", "other"),
    ).toBeNull();
  });
});
