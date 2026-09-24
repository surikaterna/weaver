import {
  configurationContextSchema,
  configurationLayerDataSchema,
  configurationLayerEntrySchema,
  scopeDefinitionSchema,
  scopeInstanceSchema,
} from "../src/schemas-layers.js";
import {
  providerIdSchema,
  publicConfigPathSchema,
  registrationEnvironmentSchema,
  serviceIdSchema,
  slotPathSchema,
} from "../src/schemas-registration-paths.js";
import {
  fragmentSchemaRegistrationRequestSchema,
  fragmentSlotRegistrationMetadataSchema,
  schemaRegistrationMetadataSchema,
  serviceSchemaRegistrationRequestSchema,
} from "../src/schemas-schema-registration.js";

describe("scopeDefinitionSchema", () => {
  it("accepts valid scope definition", () => {
    const result = scopeDefinitionSchema.safeParse({
      id: "org",
      label: "Organization",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional parentScopeId", () => {
    const result = scopeDefinitionSchema.safeParse({
      id: "team",
      label: "Team",
      parentScopeId: "org",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = scopeDefinitionSchema.safeParse({ id: "x" });
    expect(result.success).toBe(false);
  });
});

describe("scopeInstanceSchema", () => {
  it("accepts valid instance", () => {
    const result = scopeInstanceSchema.safeParse({
      scopeId: "org",
      value: "acme",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-string value", () => {
    const result = scopeInstanceSchema.safeParse({
      scopeId: "org",
      value: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("configurationContextSchema", () => {
  it("accepts valid context", () => {
    const result = configurationContextSchema.safeParse({
      scopePath: [{ scopeId: "org", value: "acme" }],
      userId: "u1",
      deviceId: "d1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing userId", () => {
    const result = configurationContextSchema.safeParse({
      scopePath: [],
      deviceId: "d1",
    });
    expect(result.success).toBe(false);
  });
});

describe("configurationLayerEntrySchema", () => {
  it("accepts valid entry", () => {
    const result = configurationLayerEntrySchema.safeParse({
      layer: "defaults",
      entries: { "app.theme": "dark" },
    });
    expect(result.success).toBe(true);
  });
});

describe("configurationLayerDataSchema", () => {
  it("accepts entries with optional revision", () => {
    const result = configurationLayerDataSchema.safeParse({
      entries: { key: "value" },
      revision: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts entries without optional fields", () => {
    const result = configurationLayerDataSchema.safeParse({
      entries: {},
    });
    expect(result.success).toBe(true);
  });
});

describe("schema registration request schemas", () => {
  const invalidRootSchemas = [
    { type: "string" },
    { type: "array", items: { type: "string" } },
    { properties: { enabled: { type: "boolean" } } },
    { oneOf: [{ type: "object" }, { type: "string" }] },
    { type: ["object", "null"] },
  ];

  it("enforces registration identifier and slot path lexical contracts", () => {
    for (const id of ["lynx", "checkout-api"]) {
      expect(serviceIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ["_weaver", "Upper", "bad/id", "constructor"]) {
      expect(serviceIdSchema.safeParse(id).success).toBe(false);
    }
    for (const id of ["ghost.settings.panel", "Ghost_2", "provider-id"]) {
      expect(providerIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ["bad/id", " bad", "prototype", "provider[dot]"]) {
      expect(providerIdSchema.safeParse(id).success).toBe(false);
    }
    for (const path of ["/plugins", "/plugin.keys/nested-key"]) {
      expect(slotPathSchema.safeParse(path).success).toBe(true);
    }
    for (const path of [
      "plugins",
      "/",
      "/plugins/",
      "/plugins//nested",
      "/[plugins]",
      "/plugins/__proto__",
    ]) {
      expect(slotPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it("validates public canonical paths with the same segment rules", () => {
    for (const path of ["/lynx", "/lynx/plugin.keys", "/lynx/plugins/"]) {
      expect(publicConfigPathSchema.safeParse(path).success).toBe(true);
    }
    for (const path of [
      "/",
      "lynx",
      "/_weaver/registry",
      "/lynx//plugins",
      "/lynx/[plugin.keys]",
      "/lynx/constructor",
    ]) {
      expect(publicConfigPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it("rejects service-prefixed slot paths", () => {
    const request = {
      serviceId: "lynx",
      environment: "default",
      owner: { name: "Lynx", contact: "lynx@example.com" },
      schema: { type: "object" },
      fragmentSlots: [{ slotPath: "/lynx/plugins", accepts: "object" }],
    };
    expect(
      serviceSchemaRegistrationRequestSchema.safeParse(request).success,
    ).toBe(false);
    expect(
      fragmentSchemaRegistrationRequestSchema.safeParse({
        ...request,
        providerId: "ghost.settings.panel",
        slotPath: "/lynx/plugins",
      }).success,
    ).toBe(false);
  });

  it("accepts path-first service registration shape", () => {
    const result = serviceSchemaRegistrationRequestSchema.safeParse({
      serviceId: "example-service",
      environment: "default",
      owner: {
        name: "Example Service",
        contact: "example-service@example.com",
      },
      schema: { type: "object" },
      schemaVersion: "1.2.3",
      fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects service root path, namespace, ownerId, and missing slots", () => {
    expect(
      serviceSchemaRegistrationRequestSchema.safeParse({
        serviceId: "example-service",
        environment: "default",
        owner: {
          name: "Example Service",
          contact: "example-service@example.com",
        },
        schema: { type: "object" },
        path: "/custom",
      }).success,
    ).toBe(false);

    expect(
      serviceSchemaRegistrationRequestSchema.safeParse({
        serviceId: "example-service",
        environment: "default",
        owner: {
          name: "Example Service",
          contact: "example-service@example.com",
        },
        schema: { type: "object" },
        fragmentSlots: [],
        namespace: "legacy",
        ownerId: "team-a",
      }).success,
    ).toBe(false);
  });

  it("accepts fragment registration and rejects independent fragment path", () => {
    const valid = fragmentSchemaRegistrationRequestSchema.safeParse({
      serviceId: "example-service",
      providerId: "ghost.settings.panel",
      slotPath: "/plugins",
      environment: "default",
      owner: { name: "Ghost", contact: "ghost@example.com" },
      schema: { type: "object" },
      schemaVersion: "0.4.0",
    });

    expect(valid.success).toBe(true);
    expect(
      fragmentSchemaRegistrationRequestSchema.safeParse({
        serviceId: "example-service",
        providerId: "ghost.settings.panel",
        slotPath: "/plugins",
        environment: "default",
        owner: { name: "Ghost", contact: "ghost@example.com" },
        schema: { type: "object" },
        path: "/example-service/plugins/ghost.settings.panel",
      }).success,
    ).toBe(false);
  });

  it("rejects prototype-unsafe registration environments", () => {
    for (const environment of ["__proto__", "constructor", "prototype"]) {
      expect(registrationEnvironmentSchema.safeParse(environment).success).toBe(
        false,
      );
      expect(
        serviceSchemaRegistrationRequestSchema.safeParse({
          serviceId: "example-service",
          environment,
          owner: {
            name: "Example Service",
            contact: "example-service@example.com",
          },
          schema: { type: "object" },
          fragmentSlots: [],
        }).success,
      ).toBe(false);
      expect(
        fragmentSchemaRegistrationRequestSchema.safeParse({
          serviceId: "example-service",
          providerId: "ghost.settings.panel",
          slotPath: "/plugins",
          environment,
          owner: { name: "Ghost", contact: "ghost@example.com" },
          schema: { type: "object" },
        }).success,
      ).toBe(false);
      expect(
        schemaRegistrationMetadataSchema.safeParse({
          serviceId: "lynx",
          servicePath: "/lynx",
          environment,
          providerId: "lynx",
          owner: { name: "Lynx", contact: "lynx@example.com" },
        }).success,
      ).toBe(false);
      expect(
        fragmentSlotRegistrationMetadataSchema.safeParse({
          serviceId: "lynx",
          servicePath: "/lynx",
          slotPath: "/plugins",
          canonicalSlotPath: "/lynx/plugins",
          environment,
          providerId: "lynx",
          owner: { name: "Lynx", contact: "lynx@example.com" },
          accepts: "object",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects non-object and ambiguous service schema roots", () => {
    for (const schema of invalidRootSchemas) {
      const result = serviceSchemaRegistrationRequestSchema.safeParse({
        serviceId: "lynx",
        environment: "default",
        owner: { name: "Lynx", contact: "lynx@example.com" },
        schema,
        fragmentSlots: [],
      });

      expect(result.success).toBe(false);
    }
  });

  it("rejects non-object and ambiguous fragment schema roots", () => {
    for (const schema of invalidRootSchemas) {
      const result = fragmentSchemaRegistrationRequestSchema.safeParse({
        serviceId: "lynx",
        providerId: "ghost.settings.panel",
        slotPath: "/plugins",
        environment: "default",
        owner: { name: "Ghost", contact: "ghost@example.com" },
        schema,
      });

      expect(result.success).toBe(false);
    }
  });

  it("accepts response metadata with owner, provider identity, and audit", () => {
    const result = schemaRegistrationMetadataSchema.safeParse({
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

    expect(result.success).toBe(true);
  });
});
