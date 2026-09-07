import { deepRemove, deepSet } from "@weaver-conf/config-engine";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createTestProvider(id, layer, entries = {}, writable = true) {
  let data = clone(entries);
  const writes = [];
  return {
    id,
    layer,
    writable,
    writes,
    async load() {
      return { entries: clone(data) };
    },
    async write(key, value) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      writes.push({ key, value: clone(value) });
      deepSet(data, key, value);
      return { success: true };
    },
    async remove(key) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      deepRemove(data, key);
      return { success: true };
    },
    entries() {
      return clone(data);
    },
  };
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
    const invalid = await service.setRegisteredObject(
      "platform",
      "/billing",
      { mode: "qa" },
      { schemaRegistry: registry },
    );

    expect(partial.success).toBe(true);
    expect(provider.writes[0]).toEqual({ key: "billing", value: { limit: 10 } });
    expect(invalid.success).toBe(false);
    expect(invalid.error?.details?.errors?.[0]?.path).toBe("$.billing.mode");
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
    const invalid = await service.setRegisteredObject(
      "platform",
      "/billing/plugins/tax",
      { providerEnabled: "yes" },
      { schemaRegistry: registry },
    );

    expect(valid.success).toBe(true);
    expect(provider.writes[0]).toEqual({
      key: "billing.plugins.tax",
      value: { providerEnabled: true },
    });
    expect(invalid.success).toBe(false);
    expect(invalid.error?.details?.anchorPath).toBe("/billing/plugins/tax");
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

    expect(result.success).toBe(true);
    expect(provider.writes.at(-1)).toEqual({
      key: "billing",
      value: { mode: "test", limit: 5 },
    });
    expect(await service.get("billing.limit")).toBe(5);
  });

  test("invalid type, unknown property, enum, and nested shape patches are rejected", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });

    const invalidType = await service.patchRegisteredPath("platform", "/billing/limit", "high", { schemaRegistry: registry });
    const unknown = await service.patchRegisteredPath("platform", "/billing/unknown", true, { schemaRegistry: registry });
    const invalidEnum = await service.patchRegisteredPath("platform", "/billing/mode", "qa", { schemaRegistry: registry });
    const invalidNested = await service.patchRegisteredPath("platform", "/billing/nested", { enabled: "yes" }, { schemaRegistry: registry });

    expect([invalidType, unknown, invalidEnum, invalidNested].every((item) => !item.success)).toBe(true);
    expect(provider.writes).toEqual([]);
  });

  test("prototype-pollution path segments are rejected without mutating prototypes", async () => {
    const provider = createTestProvider("p1", "platform", { service: {} });
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(extensibleServiceSchema, [], "service"));

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

        expect(result.success).toBe(false);
        expect(result.error?.message).toContain(`Path segment "${segment}" is not allowed`);
      }

      expect(Reflect.get(Object.prototype, "x")).toBe(undefined);
      expect(provider.writes).toEqual([]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "x");
    }
  });

  test("effective completeness validation fails missing required fields when checked", async () => {
    const { registry, service } = await makeRegisteredService({ billing: { limit: 10 } });

    const result = await service.validateRegisteredEffective("/billing", {
      schemaRegistry: registry,
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "missing-required",
      path: "$.billing.mode",
    });
  });

  test("protected and unregistered public write paths are rejected", async () => {
    const { registry, service } = await makeRegisteredService();

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

    expect(protectedRoot.success).toBe(false);
    expect(bracketRoot.success).toBe(false);
    expect(unregistered.success).toBe(false);
    expect(unregistered.error?.message).toContain("No registered schema anchor");
  });

  test("invalid persisted anchor objects are rejected at patch boundaries", async () => {
    const { registry, service } = await makeRegisteredService({
      billing: { mode: "test", limit: "bad" },
    });

    const result = await service.patchRegisteredPath(
      "platform",
      "/billing/mode",
      "prod",
      { schemaRegistry: registry },
    );

    expect(result.success).toBe(false);
    expect(result.error?.details?.errors?.[0]).toMatchObject({
      code: "invalid-type",
      path: "$.billing.limit",
    });
    expect(await service.get("billing.mode")).toBe("test");
  });
});
