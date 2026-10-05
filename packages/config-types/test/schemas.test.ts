import {
  configurationContextSchema,
  configurationLayerDataSchema,
  configurationLayerEntrySchema,
  scopeDefinitionSchema,
  scopeInstanceSchema,
} from "../src/schemas-layers.js";
import { schemaDomainAuditEntrySchema } from "../src/schemas-promotion.js";
import { configurationPropertySchemaSchema } from "../src/schemas-property.js";
import {
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteRequestSchema,
  registeredObjectWriteResponseSchema,
  registeredSchemaDetailRequestSchema,
  registeredSchemaDetailResponseSchema,
  registeredSchemaIdentityListResponseSchema,
  registeredSchemasResponseSchema,
} from "../src/schemas-registered-operations.js";
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

describe("targeted registered schema contracts", () => {
  it("rejects unsafe identities and noncanonical detail requests", () => {
    expect(
      registeredSchemaIdentityListResponseSchema.parse({
        anchors: [],
        slots: [],
      }),
    ).toEqual({ anchors: [], slots: [] });
    expect(
      registeredSchemaIdentityListResponseSchema.safeParse({
        anchors: [
          {
            kind: "fragment",
            path: "/app/plugin.name",
            environment: "dev",
            owner: "hidden",
          },
        ],
        slots: [],
      }).success,
    ).toBe(false);
    for (const path of [
      "/app/",
      "/app/../config",
      "/app/__proto__",
      "/app/a%2Fb",
      "/app/a\\b",
    ]) {
      expect(
        registeredSchemaDetailRequestSchema.safeParse({
          anchorPath: path,
          environment: "dev",
        }).success,
      ).toBe(false);
    }
    expect(
      registeredSchemaDetailRequestSchema.safeParse({
        anchorPath: "/app/plugin.name:one",
        environment: "dev",
      }).success,
    ).toBe(true);
  });

  it("refuses cycles and strips inherited prototype data at the detail boundary", () => {
    const metadata = {
      serviceId: "app",
      servicePath: "/app",
      environment: "dev",
      providerId: "app",
      owner: { name: "App", contact: "app@example.com" },
    };
    const cycle: Record<string, unknown> = { type: "object" };
    cycle.properties = { self: cycle };
    const detail = (schema: unknown) => ({
      kind: "service",
      path: "/app",
      environment: "dev",
      metadata,
      schema,
    });
    expect(
      registeredSchemaDetailResponseSchema.safeParse(detail(cycle)).success,
    ).toBe(false);
    const inherited = Object.assign(Object.create({ inherited: "unsafe" }), {
      type: "object",
    });
    const parsed = registeredSchemaDetailResponseSchema.parse(
      detail(inherited),
    );
    expect(Object.getPrototypeOf(parsed.schema)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed.schema, "inherited")).toBe(false);
  });
});

describe("registered operation schemas", () => {
  it("validates canonical requests and rejects malformed paths", () => {
    expect(
      registeredObjectWriteRequestSchema.safeParse({
        anchorPath: "/checkout",
        value: { enabled: true },
      }).success,
    ).toBe(true);
    expect(
      registeredObjectWriteRequestSchema.safeParse({
        anchorPath: "checkout",
        value: {},
      }).success,
    ).toBe(false);
  });

  it("validates success and non-success responses strictly", () => {
    expect(
      registeredObjectWriteResponseSchema.safeParse({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "invalid value" },
      }).success,
    ).toBe(true);
    expect(
      registeredObjectWriteResponseSchema.safeParse({
        success: false,
        error: "invalid value",
      }).success,
    ).toBe(false);
    expect(
      registeredEffectiveValidationResponseSchema.safeParse({
        valid: false,
        errors: [{ code: "unknown", path: "/x", segments: [], message: "x" }],
      }).success,
    ).toBe(false);
  });

  it("validates registered schema maps", () => {
    expect(
      registeredSchemasResponseSchema.safeParse({
        schemas: { "/checkout": { type: "object" } },
      }).success,
    ).toBe(true);
    expect(
      registeredSchemasResponseSchema.safeParse({
        schemas: { "/checkout": { type: "unsupported" } },
      }).success,
    ).toBe(false);
  });
});

describe("schema audit schemas", () => {
  it("validates typed schema operation outcomes", () => {
    const result = schemaDomainAuditEntrySchema.safeParse({
      domain: "schema",
      timestamp: "2026-09-18T00:00:00.000Z",
      actor: "svc:checkout",
      action: "schema.patch.path",
      key: "/checkout/db/host",
      environment: "prod",
      success: false,
      error: "Registered path patch failed",
      metadata: {
        operation: "schema.patch.path",
        subject: "svc:checkout",
        serviceId: "checkout",
        writePath: "/checkout/db/host",
        environment: "prod",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects mismatched or empty schema audit fields", () => {
    expect(
      schemaDomainAuditEntrySchema.safeParse({
        domain: "schema",
        timestamp: "now",
        actor: "",
        action: "schema.write.object",
        key: "",
        environment: "",
        success: true,
        metadata: { operation: "schema.write.object" },
      }).success,
    ).toBe(false);
  });
});

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

describe("configurationPropertySchemaSchema composition", () => {
  it("admits all four supported fields recursively", () => {
    const schema = {
      type: "object",
      properties: {
        choice: {
          type: "string",
          anyOf: [{ type: "string", const: "a" }],
          oneOf: [{ type: "string", minLength: 1 }],
          allOf: [{ type: "string", maxLength: 2 }],
          not: { type: "string", const: "blocked" },
        },
      },
      additionalProperties: false,
    };

    expect(configurationPropertySchemaSchema.parse(schema)).toEqual(schema);
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

  it("strips legacy subjects from persisted registration metadata", () => {
    const result = schemaRegistrationMetadataSchema.safeParse({
      serviceId: "app",
      servicePath: "/app",
      environment: "default",
      providerId: "app",
      owner: { name: "application", contact: "app@example.com" },
      audit: { subject: "svc:app", actor: "api" },
    });

    expect(result.success).toBe(true);
    expect(result.data?.audit).toEqual({ actor: "api" });
  });

  it("enforces registration identifier and slot path lexical contracts", () => {
    for (const id of ["app", "checkout-api"]) {
      expect(serviceIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ["_weaver", "Upper", "bad/id", "constructor"]) {
      expect(serviceIdSchema.safeParse(id).success).toBe(false);
    }
    for (const id of ["example.settings.panel", "Example_2", "provider-id"]) {
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
    for (const path of ["/app", "/app/plugin.keys", "/app/plugins/"]) {
      expect(publicConfigPathSchema.safeParse(path).success).toBe(true);
    }
    for (const path of [
      "/",
      "app",
      "/_weaver/registry",
      "/app//plugins",
      "/app/[plugin.keys]",
      "/app/constructor",
    ]) {
      expect(publicConfigPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it("rejects service-prefixed slot paths", () => {
    const request = {
      serviceId: "app",
      environment: "default",
      owner: { name: "application", contact: "app@example.com" },
      schema: { type: "object" },
      fragmentSlots: [{ slotPath: "/app/plugins", accepts: "object" }],
    };
    expect(
      serviceSchemaRegistrationRequestSchema.safeParse(request).success,
    ).toBe(false);
    expect(
      fragmentSchemaRegistrationRequestSchema.safeParse({
        ...request,
        providerId: "example.settings.panel",
        slotPath: "/app/plugins",
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
      providerId: "example.settings.panel",
      slotPath: "/plugins",
      environment: "default",
      owner: { name: "Example Team", contact: "example@example.com" },
      schema: { type: "object" },
      schemaVersion: "0.4.0",
    });

    expect(valid.success).toBe(true);
    expect(
      fragmentSchemaRegistrationRequestSchema.safeParse({
        serviceId: "example-service",
        providerId: "example.settings.panel",
        slotPath: "/plugins",
        environment: "default",
        owner: { name: "Example Team", contact: "example@example.com" },
        schema: { type: "object" },
        path: "/example-service/plugins/example.settings.panel",
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
          providerId: "example.settings.panel",
          slotPath: "/plugins",
          environment,
          owner: { name: "Example Team", contact: "example@example.com" },
          schema: { type: "object" },
        }).success,
      ).toBe(false);
      expect(
        schemaRegistrationMetadataSchema.safeParse({
          serviceId: "app",
          servicePath: "/app",
          environment,
          providerId: "app",
          owner: { name: "application", contact: "app@example.com" },
        }).success,
      ).toBe(false);
      expect(
        fragmentSlotRegistrationMetadataSchema.safeParse({
          serviceId: "app",
          servicePath: "/app",
          slotPath: "/plugins",
          canonicalSlotPath: "/app/plugins",
          environment,
          providerId: "app",
          owner: { name: "application", contact: "app@example.com" },
          accepts: "object",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects non-object and ambiguous service schema roots", () => {
    for (const schema of invalidRootSchemas) {
      const result = serviceSchemaRegistrationRequestSchema.safeParse({
        serviceId: "app",
        environment: "default",
        owner: { name: "application", contact: "app@example.com" },
        schema,
        fragmentSlots: [],
      });

      expect(result.success).toBe(false);
    }
  });

  it("rejects non-object and ambiguous fragment schema roots", () => {
    for (const schema of invalidRootSchemas) {
      const result = fragmentSchemaRegistrationRequestSchema.safeParse({
        serviceId: "app",
        providerId: "example.settings.panel",
        slotPath: "/plugins",
        environment: "default",
        owner: { name: "Example Team", contact: "example@example.com" },
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
