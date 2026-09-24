import { createWeaverClient } from "../src/client.js";
import type { ClientSchemaRegistry } from "../src/schema-registry.js";
import type { WeaverTransport } from "../src/transport.js";
import { validateOnRead, validateOnWrite } from "../src/validation.js";

function createMockRegistry(
  overrides: Partial<ClientSchemaRegistry> = {},
): ClientSchemaRegistry {
  return {
    load: () => {},
    getSchema: () => undefined,
    isSensitive: () => false,
    getReloadBehavior: () => undefined,
    validate: () => ({ valid: true, errors: [] }),
    ...overrides,
  };
}

describe("validateOnRead", () => {
  it("passes valid value through", () => {
    const registry = createMockRegistry({
      validate: () => ({ valid: true, errors: [] }),
    });
    const result = validateOnRead("key", 42, registry, {
      warnOnMismatch: true,
    });
    expect(result).toBe(42);
  });

  it("returns value but warns on invalid", () => {
    const registry = createMockRegistry({
      validate: () => ({
        valid: false,
        errors: [
          {
            code: "invalid-type",
            path: "",
            segments: [],
            message: "bad type",
          },
        ],
      }),
    });
    const warns: string[] = [];
    const logger = { warn: (msg: string) => warns.push(msg) };
    const result = validateOnRead("key", "bad", registry, {
      warnOnMismatch: true,
      logger,
    });
    expect(result).toBe("bad");
    expect(warns.length).toBe(1);
    expect(warns[0].includes("bad type")).toBeTruthy();
  });

  it("returns value as-is when no registry", () => {
    const result = validateOnRead("key", "hello", undefined, {
      warnOnMismatch: true,
    });
    expect(result).toBe("hello");
  });

  it("suppresses warnings when warnOnMismatch is false", () => {
    const registry = createMockRegistry({
      validate: () => ({
        valid: false,
        errors: [
          {
            code: "invalid-type",
            path: "",
            segments: [],
            message: "bad",
          },
        ],
      }),
    });
    const warns: string[] = [];
    const logger = { warn: (msg: string) => warns.push(msg) };
    const result = validateOnRead("key", "val", registry, {
      warnOnMismatch: false,
      logger,
    });
    expect(result).toBe("val");
    expect(warns.length).toBe(0);
  });
});

describe("validateOnWrite", () => {
  it("returns valid for valid value", () => {
    const registry = createMockRegistry({
      validate: () => ({ valid: true, errors: [] }),
    });
    const result = validateOnWrite("key", 42, registry);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("returns invalid for bad value", () => {
    const errors = [
      {
        code: "invalid-type" as const,
        path: "",
        segments: [],
        message: "Expected number, got string",
      },
    ];
    const registry = createMockRegistry({
      validate: () => ({ valid: false, errors }),
    });
    const result = validateOnWrite("key", "bad", registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(errors);
  });
});

function createMockTransport(
  overrides: Partial<WeaverTransport> = {},
): WeaverTransport {
  return {
    resolveAll: async () => ({
      entries: {},
      scopes: {},
      revision: "r1",
      timestamp: new Date().toISOString(),
    }),
    resolve: async () => undefined,
    inspect: async () => ({
      key: "",
      effectiveValue: undefined,
      layerValues: {},
    }),
    set: async () => ({ success: true, revision: "r2" }),
    setMany: async () => ({ success: true }),
    remove: async () => ({ success: true }),
    subscribe: () => () => {},
    listScopes: async () => [],
    listScopeValues: async () => [],
    close: async () => {},
    ...overrides,
  };
}

describe("client validation integration", () => {
  it("set() rejects invalid value without calling transport", async () => {
    let transportCalled = false;
    const transport = createMockTransport({
      set: async () => {
        transportCalled = true;
        return { success: true };
      },
      resolveAll: async () => ({
        entries: {},
        scopes: {},
        revision: "r1",
        timestamp: new Date().toISOString(),
      }),
    });
    // Add fetchSchemas to transport
    (transport as Record<string, unknown>).fetchSchemas = async () => ({
      "/app/port:default": { type: "number" as const },
    });

    const client = await createWeaverClient({ transport, schemas: true });
    const result = await client.set("app.port", "not-a-number");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect(transportCalled).toBe(false);
  });

  it("set() allows valid value through to transport", async () => {
    let transportCalled = false;
    const transport = createMockTransport({
      set: async () => {
        transportCalled = true;
        return { success: true, revision: "r2" };
      },
    });
    (transport as Record<string, unknown>).fetchSchemas = async () => ({
      "/app/port:default": { type: "number" as const },
    });

    const client = await createWeaverClient({ transport, schemas: true });
    const result = await client.set("app.port", 8080);
    expect(result.success).toBe(true);
    expect(transportCalled).toBe(true);
  });

  it("validate() returns ValidationResult", async () => {
    const transport = createMockTransport();
    (transport as Record<string, unknown>).fetchSchemas = async () => ({
      "/app/name:default": { type: "string" as const },
    });

    const client = await createWeaverClient({ transport, schemas: true });
    const valid = client.validate("app.name", "hello");
    expect(valid.valid).toBe(true);
    const invalid = client.validate("app.name", 123);
    expect(invalid.valid).toBe(false);
  });

  it("isSensitive() returns correct boolean", async () => {
    const transport = createMockTransport();
    (transport as Record<string, unknown>).fetchSchemas = async () => ({
      "/db/password:default": {
        type: "string" as const,
        "x-weaver": { sensitive: true },
      },
      "/app/name:default": { type: "string" as const },
    });

    const client = await createWeaverClient({ transport, schemas: true });
    expect(client.isSensitive("db.password")).toBe(true);
    expect(client.isSensitive("app.name")).toBe(false);
  });

  it("works without schemas option", async () => {
    const transport = createMockTransport();
    const client = await createWeaverClient({ transport });
    // validate/isSensitive still work, just return defaults
    expect(client.validate("any", "val")).toEqual({
      valid: true,
      errors: [],
    });
    expect(client.isSensitive("any")).toBe(false);
  });

  it("validates explicit schema environments through the registration contract", async () => {
    const transport = createMockTransport();
    (transport as Record<string, unknown>).fetchSchemas = async () => ({
      "/app/value:default": { type: "string" as const },
      "/app/value:production": { type: "number" as const },
    });
    const client = await createWeaverClient({
      transport,
      schemas: { environment: "production" },
    });
    expect(client.validate("app.value", 1).valid).toBe(true);
    await expect(
      createWeaverClient({ transport, schemas: { environment: "__proto__" } }),
    ).rejects.toThrow();
  });
});
