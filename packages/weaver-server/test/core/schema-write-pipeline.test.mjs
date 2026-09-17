import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";

function createTestProvider(id, layer, entries = {}) {
  const provider = createInMemoryStorageProvider({
    id,
    layer,
    initialEntries: entries,
  });
  const writes = [];
  const write = provider.write.bind(provider);
  provider.write = async (key, value) => {
    const result = await write(key, value);
    if (result.success) writes.push({ key, value: structuredClone(value) });
    return result;
  };
  provider.writes = writes;
  return provider;
}

async function providerEntries(provider) {
  return (await provider.load()).entries;
}

function schemaFailure(path, anchorPath, error) {
  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "Configuration does not match registered schema",
      details: { path, anchorPath, environment: "test", errors: [error] },
    },
  };
}

function writeFailure(code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return { success: false, error };
}

async function expectNoEffects(provider, service, entries, revision) {
  expect(provider.writes).toEqual([]);
  expect(await providerEntries(provider)).toEqual(entries);
  expect(service.revision).toBe(revision);
}

function owner(name = "billing") {
  return { name, contact: `${name}@example.com` };
}

function serviceRegistration(schema, fragmentSlots = [], serviceId = "billing") {
  return {
    serviceId,
    environment: "test",
    owner: owner(serviceId),
    schema,
    fragmentSlots,
  };
}

async function makeRegisteredService(entries = {}) {
  const provider = createTestProvider("p1", "platform", entries);
  const service = await createWeaverConfigService({
    providers: [provider],
    environment: "test",
  });
  const registry = createSchemaRegistry({ configService: service });
  await registry.register(serviceRegistration(serviceSchema));
  return { provider, registry, service };
}

const serviceSchema = {
  type: "object",
  required: ["mode"],
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["prod", "test"] },
    limit: { type: "number" },
    nested: {
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean" } },
    },
  },
};

const fragmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: { providerEnabled: { type: "boolean" } },
};

const extensibleServiceSchema = {
  type: "object",
  additionalProperties: true,
};

describe("schema-registered config writes", () => {
  test("object writes at registered service anchors validate partial compatibility", async () => {
    const { provider, registry, service } = await makeRegisteredService();

    const partial = await service.setRegisteredObject(
      "platform",
      "/billing",
      { limit: 10 },
      { schemaRegistry: registry },
    );
    const acceptedEntries = await providerEntries(provider);
    const acceptedRevision = service.revision;
    const invalid = await service.setRegisteredObject(
      "platform",
      "/billing",
      { mode: "qa" },
      { schemaRegistry: registry },
    );

    expect(partial).toEqual({ success: true });
    expect(provider.writes).toEqual([
      { key: "billing", value: { limit: 10 } },
    ]);
    expect(invalid).toEqual(
      schemaFailure("/billing", "/billing", {
        code: "invalid-value",
        path: "$.billing.mode",
        segments: ["billing", "mode"],
        message: "Value is not in the allowed enum values",
      }),
    );
    expect(await providerEntries(provider)).toEqual(acceptedEntries);
    expect(service.revision).toBe(acceptedRevision);
  });

  test("object writes at registered fragment anchors validate partial compatibility", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(serviceSchema, [{ slotPath: "/plugins", accepts: "object" }]));
    await registry.register({
      serviceId: "billing",
      providerId: "tax",
      slotPath: "/plugins",
      environment: "test",
      owner: owner("tax"),
      schema: fragmentSchema,
    });

    const valid = await service.setRegisteredObject(
      "platform",
      "/billing/plugins/tax",
      { providerEnabled: true },
      { schemaRegistry: registry },
    );
    const acceptedEntries = await providerEntries(provider);
    const acceptedRevision = service.revision;
    const invalid = await service.setRegisteredObject(
      "platform",
      "/billing/plugins/tax",
      { providerEnabled: "yes" },
      { schemaRegistry: registry },
    );

    expect(valid).toEqual({ success: true });
    expect(provider.writes).toEqual([
      {
        key: "billing.plugins.tax",
        value: { providerEnabled: true },
      },
    ]);
    expect(invalid.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Configuration does not match registered schema",
      details: {
        path: "/billing/plugins/tax",
        anchorPath: "/billing/plugins/tax",
        environment: "test",
      },
    });
    expect(await providerEntries(provider)).toEqual(acceptedEntries);
    expect(service.revision).toBe(acceptedRevision);
  });

  test("property patches validate members and persist the resulting anchor object", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test", limit: 1 },
    });

    const result = await service.patchRegisteredPath(
      "platform",
      "/billing/limit",
      5,
      { schemaRegistry: registry },
    );

    expect(result).toEqual({ success: true });
    expect(provider.writes).toEqual([
      { key: "billing", value: { mode: "test", limit: 5 } },
    ]);
    expect(await providerEntries(provider)).toEqual({
      billing: { mode: "test", limit: 5 },
    });
    expect(await service.get("billing.limit")).toBe(5);
  });

  test("invalid type, unknown property, enum, and nested shape patches are rejected", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const invalidType = await service.patchRegisteredPath(
      "platform",
      "/billing/limit",
      "high",
      { schemaRegistry: registry },
    );
    const unknown = await service.patchRegisteredPath(
      "platform",
      "/billing/unknown",
      true,
      { schemaRegistry: registry },
    );
    const invalidEnum = await service.patchRegisteredPath(
      "platform",
      "/billing/mode",
      "qa",
      { schemaRegistry: registry },
    );
    const invalidNested = await service.patchRegisteredPath(
      "platform",
      "/billing/nested",
      { enabled: "yes" },
      { schemaRegistry: registry },
    );
    const anchorPatch = await service.patchRegisteredPath(
      "platform",
      "/billing",
      {},
      { schemaRegistry: registry },
    );

    expect(invalidType).toEqual(
      schemaFailure("/billing/limit", "/billing", {
        code: "invalid-type",
        path: "$.billing.limit",
        segments: ["billing", "limit"],
        message: "Value does not match schema type",
        expected: "number",
        actual: "string",
      }),
    );
    expect(unknown).toEqual(
      schemaFailure("/billing/unknown", "/billing", {
        code: "unknown-property",
        path: "$.billing.unknown",
        segments: ["billing", "unknown"],
        message: 'Unknown property "unknown" is not allowed',
      }),
    );
    expect(invalidEnum.error?.code).toBe("VALIDATION_ERROR");
    expect(invalidNested.error?.code).toBe("VALIDATION_ERROR");
    expect(anchorPatch).toEqual(
      writeFailure(
        "VALIDATION_ERROR",
        "Patches must target a path below a registered anchor",
        {
          path: "/billing",
          anchorPath: "/billing",
          environment: "test",
        },
      ),
    );
    await expectNoEffects(provider, service, initialEntries, initialRevision);
  });

  test("prototype-pollution path segments are rejected without mutating prototypes", async () => {
    const provider = createTestProvider("p1", "platform", { service: {} });
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(extensibleServiceSchema, [], "service"));
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const attempts = [
      ["/service/__proto__/x", "__proto__"],
      ["/service/constructor/x", "constructor"],
      ["/service/prototype/x", "prototype"],
    ];

    Reflect.deleteProperty(Object.prototype, "x");
    try {
      for (const [path, segment] of attempts) {
        const result = await service.patchRegisteredPath("platform", path, true, {
          schemaRegistry: registry,
        });

        expect(result).toEqual({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: `Path segment "${segment}" is not allowed`,
            details: { path },
          },
        });
      }

      expect(Reflect.get(Object.prototype, "x")).toBe(undefined);
      await expectNoEffects(provider, service, initialEntries, initialRevision);
    } finally {
      Reflect.deleteProperty(Object.prototype, "x");
    }
  });

  test("effective completeness validation fails missing required fields when checked", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { limit: 10 },
    });
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const result = await service.validateRegisteredEffective("/billing", {
      schemaRegistry: registry,
    });

    expect(result).toEqual({
      valid: false,
      errors: [
        {
          code: "missing-required",
          path: "$.billing.mode",
          segments: ["billing", "mode"],
          message: 'Required property "mode" is missing',
        },
      ],
    });
    await expectNoEffects(provider, service, initialEntries, initialRevision);
  });

  test("invalid, protected, missing, and non-anchor object paths reject before writes", async () => {
    const { provider, registry, service } = await makeRegisteredService();
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const protectedRoot = await service.setRegisteredObject(
      "platform",
      "/_weaver",
      {},
      { schemaRegistry: registry },
    );
    const bracketRoot = await service.setRegisteredObject(
      "platform",
      "[_weaver]",
      {},
      { schemaRegistry: registry },
    );
    const unregistered = await service.setRegisteredObject(
      "platform",
      "/unknown",
      {},
      { schemaRegistry: registry },
    );
    const malformed = await service.setRegisteredObject(
      "platform",
      "billing",
      {},
      { schemaRegistry: registry },
    );
    const descendant = await service.setRegisteredObject(
      "platform",
      "/billing/limit",
      4,
      { schemaRegistry: registry },
    );

    expect(protectedRoot).toEqual(
      writeFailure(
        "VALIDATION_ERROR",
        'Path "/_weaver" is reserved for Weaver internal metadata',
      ),
    );
    expect(bracketRoot).toEqual(
      writeFailure(
        "VALIDATION_ERROR",
        'Path "[_weaver]" is reserved for Weaver internal metadata',
      ),
    );
    expect(unregistered).toEqual(
      writeFailure(
        "VALIDATION_ERROR",
        'No registered schema anchor for path "/unknown" in environment "test"',
        { path: "/unknown", environment: "test" },
      ),
    );
    expect(malformed).toEqual(
      writeFailure("VALIDATION_ERROR", 'Path "billing" must start with /', {
        path: "billing",
      }),
    );
    expect(descendant).toEqual(
      writeFailure(
        "VALIDATION_ERROR",
        "Object writes must target a registered schema anchor",
        {
          path: "/billing/limit",
          anchorPath: "/billing",
          environment: "test",
        },
      ),
    );
    await expectNoEffects(provider, service, initialEntries, initialRevision);
  });

  test("invalid persisted anchor objects are rejected at patch boundaries", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test", limit: "bad" },
    });
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const result = await service.patchRegisteredPath(
      "platform",
      "/billing/mode",
      "prod",
      { schemaRegistry: registry },
    );

    expect(result).toEqual(
      schemaFailure("/billing/mode", "/billing", {
        code: "invalid-type",
        path: "$.billing.limit",
        segments: ["billing", "limit"],
        message: "Value does not match schema type",
        expected: "number",
        actual: "string",
      }),
    );
    await expectNoEffects(provider, service, initialEntries, initialRevision);
    expect(await service.get("billing.mode")).toBe("test");
  });

  test("patches reject a resulting anchor object that violates schema bounds", async () => {
    const provider = createTestProvider("p1", "platform", {
      billing: { mode: "test" },
    });
    const service = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(
      serviceRegistration({
        type: "object",
        maxProperties: 1,
        additionalProperties: false,
        properties: {
          mode: { type: "string" },
          limit: { type: "number" },
        },
      }),
    );
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const result = await service.patchRegisteredPath(
      "platform",
      "/billing/limit",
      5,
      { schemaRegistry: registry },
    );

    expect(result).toEqual(
      schemaFailure("/billing/limit", "/billing", {
        code: "invalid-value",
        path: "$.billing",
        segments: ["billing"],
        message: "maxProperties requires 2 <= 1",
      }),
    );
    await expectNoEffects(provider, service, initialEntries, initialRevision);
  });

  test("registered operations reject revision conflicts before validation or writes", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });
    const currentRevision = service.revision;
    const context = {
      schemaRegistry: registry,
      expectedRevision: "stale-revision",
    };

    const objectResult = await service.setRegisteredObject(
      "platform",
      "/billing",
      { mode: "prod" },
      context,
    );
    const patchResult = await service.patchRegisteredPath(
      "platform",
      "/billing/mode",
      "prod",
      context,
    );
    const expected = writeFailure(
      "REVISION_CONFLICT",
      `Revision conflict: expected stale-revision, current is ${currentRevision}`,
    );

    expect(objectResult).toEqual(expected);
    expect(patchResult).toEqual(expected);
    await expectNoEffects(
      provider,
      service,
      { billing: { mode: "test" } },
      currentRevision,
    );
  });

  test("effective validation success and missing-anchor rejection are read-only", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const valid = await service.validateRegisteredEffective("/billing", {
      schemaRegistry: registry,
    });
    const missing = await service.validateRegisteredEffective("/unknown", {
      schemaRegistry: registry,
    });

    expect(valid).toEqual({ valid: true, errors: [] });
    expect(missing).toEqual({
      valid: false,
      errors: [
        {
          code: "invalid-path",
          message:
            'No registered schema anchor for path "/unknown" in environment "test"',
          segments: ["unknown"],
          path: "$.unknown",
        },
      ],
    });
    await expectNoEffects(provider, service, initialEntries, initialRevision);
  });
});
