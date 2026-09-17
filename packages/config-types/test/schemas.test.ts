import {
  configurationContextSchema,
  configurationLayerDataSchema,
  configurationLayerEntrySchema,
  scopeDefinitionSchema,
  scopeInstanceSchema,
} from "../src/schemas-layers.js";
import {
  fragmentSchemaRegistrationRequestSchema,
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
  it("accepts path-first service registration shape", () => {
    const result = serviceSchemaRegistrationRequestSchema.safeParse({
      serviceId: "lynx",
      environment: "default",
      owner: { name: "Lynx", contact: "lynx@example.com" },
      schema: { type: "object" },
      schemaVersion: "1.2.3",
      fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects service root path, namespace, ownerId, and missing slots", () => {
    expect(
      serviceSchemaRegistrationRequestSchema.safeParse({
        serviceId: "lynx",
        environment: "default",
        owner: { name: "Lynx", contact: "lynx@example.com" },
        schema: { type: "object" },
        path: "/custom",
      }).success,
    ).toBe(false);

    expect(
      serviceSchemaRegistrationRequestSchema.safeParse({
        serviceId: "lynx",
        environment: "default",
        owner: { name: "Lynx", contact: "lynx@example.com" },
        schema: { type: "object" },
        fragmentSlots: [],
        namespace: "legacy",
        ownerId: "team-a",
      }).success,
    ).toBe(false);
  });

  it("accepts fragment registration and rejects independent fragment path", () => {
    const valid = fragmentSchemaRegistrationRequestSchema.safeParse({
      serviceId: "lynx",
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
        serviceId: "lynx",
        providerId: "ghost.settings.panel",
        slotPath: "/plugins",
        environment: "default",
        owner: { name: "Ghost", contact: "ghost@example.com" },
        schema: { type: "object" },
        path: "/lynx/plugins/ghost.settings.panel",
      }).success,
    ).toBe(false);
  });

  it("accepts response metadata with owner, provider identity, and audit", () => {
    const result = schemaRegistrationMetadataSchema.safeParse({
      serviceId: "lynx",
      servicePath: "/lynx",
      environment: "default",
      providerId: "lynx",
      owner: { name: "Lynx", contact: "lynx@example.com" },
      schemaVersion: "1.2.3",
      audit: { subject: "svc:lynx", actor: "api" },
    });

    expect(result.success).toBe(true);
  });
});
