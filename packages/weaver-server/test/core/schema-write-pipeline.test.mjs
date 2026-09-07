import { deepRemove, deepSet } from "@weaver-conf/config-engine";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { normalizeBatchEntries } from "../../src/core/schema-write-boundary.ts";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createTestProvider(id, layer, entries = {}, writable = true) {
  let data = clone(entries);
  const writes = [];
  const removes = [];
  return {
    id,
    layer,
    writable,
    writes,
    removes,
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
      removes.push(key);
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
  test("normal direct and batch writes validate before provider mutation", async () => {
    const { provider, service } = await makeRegisteredService({
      billing: { mode: "test", limit: 1 },
    });

    const direct = await service.set("platform", "billing.mode", "qa");
    const batch = await service.setMany("platform", {
      "unregistered.safe": true,
      "billing.limit": "many",
    });

    expect(direct.success).toBe(false);
    expect(batch.success).toBe(false);
    expect(provider.writes).toEqual([]);
    expect(await service.get("unregistered.safe")).toBe(undefined);
  });

  test("caller metadata cannot select a different write environment", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });
    await registry.register({
      ...serviceRegistration(extensibleServiceSchema),
      environment: "other",
    });

    const direct = await service.set("platform", "billing.mode", "invalid", { environment: "other" });
    const batch = await service.setMany("platform", { "billing.mode": "invalid" }, { environment: "other" });
    const remove = await service.remove("platform", "billing.mode", { environment: "other" });
    const dedicated = await service.setRegisteredObject(
      "platform",
      "/billing",
      { mode: "anything" },
      { environment: "other", schemaRegistry: registry },
    );

    expect([direct, batch, remove, dedicated].every((result) => !result.success)).toBe(true);
    expect(provider.writes).toEqual([]);
    expect(provider.removes).toEqual([]);
    expect(await service.get("billing.mode")).toBe("test");

    const matching = await service.set("platform", "billing.mode", "prod", { environment: "test" });
    expect(matching.success).toBe(true);
    expect(provider.writes).toEqual([{ key: "billing.mode", value: "prod" }]);
  });

  test("batches canonicalize keys and reject semantic duplicates before provider I/O", async () => {
    const { provider, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });
    const validAlias = await service.setMany("platform", {
      "billing[mode]": "prod",
    });
    expect(provider.writes).toEqual([{ key: "billing.mode", value: "prod" }]);
    provider.writes.length = 0;
    let attemptedWrites = 0;
    provider.write = async () => {
      attemptedWrites++;
      return { success: false, error: { code: "WRITE_FAILED", message: "must not run" } };
    };

    const duplicate = await service.setMany("platform", {
      "billing.mode": "invalid",
      "billing[mode]": "prod",
    });

    expect(validAlias.success).toBe(true);
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.message).toContain("duplicate");
    expect(attemptedWrites).toBe(0);
    expect(provider.writes).toEqual([]);
    expect(await service.get("billing.mode")).toBe("prod");
  });

  test("batches reject ancestor and descendant paths before provider I/O", async () => {
    const cases = [
      ["descendant first", { "billing.mode": "invalid", billing: { mode: "prod" } }, "billing.mode"],
      ["ancestor first", { billing: { mode: "invalid" }, "billing.mode": "prod" }, "billing.mode"],
      ["bracket descendant first", { "billing[mode]": "invalid", billing: { mode: "prod" } }, "billing[mode]"],
      ["bracket ancestor first", { billing: { mode: "invalid" }, "billing[mode]": "prod" }, "billing[mode]"],
    ];

    for (const [name, entries, descendantSource] of cases) {
      const initial = { billing: { mode: "test", limit: 1 } };
      const { provider, service } = await makeRegisteredService(initial);
      const write = provider.write;
      let attemptedWrites = 0;
      provider.write = async (key, value) => {
        attemptedWrites++;
        if (attemptedWrites === 2) {
          return { success: false, error: { code: "WRITE_FAILED", message: "armed second failure" } };
        }
        return write(key, value);
      };

      const result = await service.setMany("platform", entries);

      expect(result, name).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Batch contains overlapping configuration paths",
          details: {
            ancestorKey: "billing",
            descendantKey: "billing.mode",
            paths: ["billing", descendantSource],
          },
        },
      });
      expect(attemptedWrites, name).toBe(0);
      expect(provider.writes, name).toEqual([]);
      expect(provider.entries(), name).toEqual(initial);
      expect(await service.get("billing"), name).toEqual(initial.billing);
    }
  });

  test("batch overlap preflight handles large sibling cardinality", () => {
    const entries = {};
    for (let index = 0; index < 25_000; index++) {
      const key = index % 2 === 0
        ? `bulk.branch${index}.value`
        : `bulk[branch${index}][value]`;
      entries[key] = index;
    }

    const normalized = normalizeBatchEntries(entries);

    expect(normalized.success).toBe(true);
    if (!normalized.success) throw new Error("Expected valid sibling batch");
    expect(Object.keys(normalized.entries)).toHaveLength(25_000);
    expect(normalized.entries["bulk.branch24999.value"]).toBe(24_999);
  });

  test("batch overlap errors select canonical paths independently of input order", () => {
    const first = normalizeBatchEntries({
      "zeta.child": true,
      zeta: {},
      "alpha.child": true,
      alpha: {},
    });
    const reversed = normalizeBatchEntries({
      alpha: {},
      "alpha.child": true,
      zeta: {},
      "zeta.child": true,
    });
    const expected = {
      success: false,
      result: {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Batch contains overlapping configuration paths",
          details: {
            ancestorKey: "alpha",
            descendantKey: "alpha.child",
            paths: ["alpha", "alpha.child"],
          },
        },
      },
    };

    expect(first).toEqual(expected);
    expect(reversed).toEqual(expected);
  });

  test("creating another registry cannot replace bound enforcement", async () => {
    const { provider, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });
    createSchemaRegistry({ configService: service });

    const result = await service.set("platform", "billing.mode", "invalid");

    expect(result.success).toBe(false);
    expect(provider.writes).toEqual([]);
  });

  test("batch validation uses the combined candidate and valid layer partials remain writable", async () => {
    const { provider, service } = await makeRegisteredService();

    const result = await service.setMany("platform", {
      "billing.mode": "prod",
      "billing.limit": 4,
    });

    expect(result.success).toBe(true);
    expect(provider.writes).toHaveLength(2);
    expect(await service.get("billing")).toEqual({ mode: "prod", limit: 4 });
  });

  test("provider failures remain fail-fast after atomic schema preflight", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const write = provider.write;
    provider.write = async (key, value) => {
      if (key === "billing.limit") {
        return { success: false, error: { code: "WRITE_FAILED", message: "failed" } };
      }
      return write(key, value);
    };
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(serviceSchema));

    const result = await service.setMany("platform", {
      "billing.mode": "prod",
      "billing.limit": 4,
    });

    expect(result.success).toBe(false);
    expect(provider.writes).toEqual([{ key: "billing.mode", value: "prod" }]);
    expect(await service.get("billing.mode")).toBe("prod");
    expect(await service.get("billing.limit")).toBe(undefined);
  });

  test("removes reject an invalid effective result but permit a valid fallback", async () => {
    const base = createTestProvider("base", "platform", { billing: { mode: "prod" } });
    const override = createTestProvider("override", "tenant:acme", {
      billing: { mode: "test" },
    });
    const service = await createWeaverConfigService({
      providers: [base, override],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(serviceSchema));

    const fallback = await service.remove("tenant:acme", "billing.mode");
    const invalid = await service.remove("platform", "billing.mode");

    expect(fallback.success).toBe(true);
    expect(invalid.success).toBe(false);
    expect(base.removes).toEqual([]);
    expect(override.removes).toEqual(["billing.mode"]);
  });

  test("ancestor writes validate contained anchors and descendants use the deepest anchor", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(extensibleServiceSchema, [{ slotPath: "/plugins", accepts: "object" }]));
    await registry.register({
      serviceId: "billing",
      providerId: "tax",
      slotPath: "/plugins",
      environment: "test",
      owner: owner("tax"),
      schema: fragmentSchema,
    });

    const ancestor = await service.set("platform", "billing", {
      plugins: { tax: { providerEnabled: "yes" } },
    });
    const descendant = await service.set(
      "platform",
      "billing.plugins.tax.providerEnabled",
      true,
    );

    expect(ancestor.success).toBe(false);
    expect(descendant.success).toBe(true);
    expect(provider.writes).toEqual([
      { key: "billing.plugins.tax.providerEnabled", value: true },
    ]);
  });

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
