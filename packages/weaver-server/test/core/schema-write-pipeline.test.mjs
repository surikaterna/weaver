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

function deepPrefixEntries(depth, reversed) {
  const segments = ["chain"];
  const entries = [];
  for (let index = 0; index < depth; index++) {
    entries.push([segments.join("."), index]);
    segments.push(`level${index}`);
  }
  return Object.fromEntries(reversed ? entries.reverse() : entries);
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

  test("deep every-prefix batches reject identically before revision or provider work", async () => {
    const expected = {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Batch contains overlapping configuration paths",
        details: {
          ancestorKey: "chain",
          descendantKey: "chain.level0",
          paths: ["chain", "chain.level0"],
        },
      },
    };

    for (const reversed of [false, true]) {
      const initial = { billing: { mode: "test" }, untouched: true };
      const { provider, service } = await makeRegisteredService(initial);
      const revision = service.revision;
      let attemptedWrites = 0;
      provider.write = async () => {
        attemptedWrites++;
        return { success: false, error: { code: "WRITE_FAILED", message: "must not run" } };
      };

      const result = await service.setMany(
        "platform",
        deepPrefixEntries(512, reversed),
        { expectedRevision: "armed-revision-conflict" },
      );

      expect(result).toEqual(expected);
      expect(attemptedWrites).toBe(0);
      expect(provider.writes).toEqual([]);
      expect(provider.entries()).toEqual(initial);
      expect(service.revision).toBe(revision);
    }
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

  test("runtime reads fail closed only when they intersect an incomplete anchor", async () => {
    const { provider, service } = await makeRegisteredService({
      billing: { limit: 10 },
      public: { ready: true },
    });

    await expect(service.resolveAll()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        kind: "effective-configuration-invalid",
        anchorPath: "/billing",
      },
    });
    await expect(service.get("billing.limit")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.getNamespace("billing")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await service.get("public.ready")).toBe(true);
    expect(await service.getNamespace("public")).toEqual({ ready: true });

    const partial = await service.set("platform", "billing.limit", 20);
    expect(partial.success).toBe(true);
    expect(provider.writes).toHaveLength(1);
    await expect(service.get("billing.limit")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const completed = await service.set("platform", "billing.mode", "prod");
    expect(completed.success).toBe(true);
    expect(await service.get("billing.limit")).toBe(20);
    expect((await service.resolveAll()).entries.billing).toEqual({
      limit: 20,
      mode: "prod",
    });
  });

  test("effective reads validate defaults, mounts, and requested scope merges", async () => {
    const base = createTestProvider("base", "platform", {
      billing: { limit: 10 },
      mounted: {
        limit: 10,
        mode: { _weaver: "mount", source: "shared.mode" },
      },
      defaults: {},
      shared: { mode: "prod" },
    });
    const tenant = createTestProvider("tenant", "tenant:acme", {
      billing: { mode: "test" },
    });
    const service = await createWeaverConfigService({
      providers: [base, tenant],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(serviceSchema));
    await registry.register(serviceRegistration(serviceSchema, [], "mounted"));
    await registry.register(serviceRegistration({
      type: "object",
      required: ["region"],
      properties: { region: { type: "string", default: "eu" } },
      additionalProperties: false,
    }, [], "defaults"));

    await expect(service.get("billing.limit")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await service.get("mounted.mode")).toBe("prod");
    expect(await service.get("defaults")).toEqual({});
    expect(await service.get("billing.mode", {
      scopePath: [{ scopeId: "tenant", value: "acme" }],
    })).toBe("test");
    await expect(service.resolveAll()).rejects.toMatchObject({
      details: { anchorPath: "/billing" },
    });
    await expect(service.resolveAll({
      scopePath: [{ scopeId: "tenant", value: "acme" }],
    })).resolves.toMatchObject({ entries: { defaults: {} } });
  });

  test("snapshots validate every returned scope against its effective merge", async () => {
    const base = createTestProvider("base", "platform", {
      billing: { mode: "prod" },
    });
    const tenant = createTestProvider("tenant", "tenant:acme", {
      billing: { mode: "invalid" },
    });
    const service = await createWeaverConfigService({
      providers: [base, tenant],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(serviceSchema));

    expect(await service.get("billing.mode")).toBe("prod");
    await expect(service.get("billing.mode", {
      scopePath: [{ scopeId: "tenant", value: "acme" }],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.resolveAll()).rejects.toMatchObject({
      details: { anchorPath: "/billing" },
    });
  });

  test("overlapping anchors are validated deterministically for intersecting reads", async () => {
    const provider = createTestProvider("p1", "platform", {
      billing: { mode: "safe", plugins: { tax: {} } },
    });
    const service = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(
      extensibleServiceSchema,
      [{ slotPath: "/plugins", accepts: "object" }],
    ));
    await registry.register({
      serviceId: "billing",
      providerId: "tax",
      slotPath: "/plugins",
      environment: "test",
      owner: owner("tax"),
      schema: {
        ...fragmentSchema,
        required: ["providerEnabled"],
      },
    });

    expect(await service.get("billing.mode")).toBe("safe");
    await expect(service.get("billing")).rejects.toMatchObject({
      details: { anchorPath: "/billing/plugins/tax" },
    });
    await expect(service.getNamespace("billing.plugins")).rejects.toMatchObject({
      details: { anchorPath: "/billing/plugins/tax" },
    });
    await expect(service.resolveAll()).rejects.toMatchObject({
      details: { anchorPath: "/billing/plugins/tax" },
    });
  });

  test("whole snapshots report invalid anchors in canonical path order", async () => {
    const provider = createTestProvider("p1", "platform", {
      alpha: {},
      zeta: {},
    });
    const service = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    const requiredSchema = {
      type: "object",
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    };
    await registry.register(serviceRegistration(requiredSchema, [], "zeta"));
    await registry.register(serviceRegistration(requiredSchema, [], "alpha"));

    await expect(service.resolveAll()).rejects.toMatchObject({
      details: { anchorPath: "/alpha" },
    });
  });

  test("object reads and source projections use the same recursively resolved state", async () => {
    const provider = createTestProvider("p1", "platform", {
      billing: {
        apiKey: { _weaver: "mount", source: "shared.token" },
      },
      shared: {
        token: { _weaver: "secret-ref", provider: "vault", uri: "good" },
      },
    });
    const secrets = new Map([["good", "SECRET-A"], ["next", "SECRET-B"]]);
    const service = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
      secretBackend: { resolve: async (ref) => secrets.get(ref.uri) },
    });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration({
      type: "object",
      required: ["apiKey"],
      properties: { apiKey: { type: "string" } },
      additionalProperties: false,
    }));

    expect(await service.get("billing")).toEqual({ apiKey: "SECRET-A" });
    expect(await service.getNamespace("billing")).toEqual({ apiKey: "SECRET-A" });
    const deltas = [];
    service.onDelta((delta) => deltas.push(delta));

    await service.set("platform", "shared.token", 42);
    expect(deltas.map((delta) => [delta.action, delta.key])).toEqual([
      ["remove", "billing"],
      ["set", "shared.token"],
    ]);
    deltas.length = 0;

    await service.set("platform", "shared.token", {
      _weaver: "secret-ref",
      provider: "vault",
      uri: "next",
    });
    expect(deltas[0]).toMatchObject({
      action: "set",
      key: "billing",
      value: { apiKey: "SECRET-B" },
      layer: "weaver-effective",
    });
    expect(JSON.stringify(deltas)).not.toContain("secret-ref");
  });

  test("overlapping anchors project one topmost root only after all members validate", async () => {
    const provider = createTestProvider("p1", "platform", {
      billing: { plugins: { tax: {} } },
    });
    const service = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    const deltas = [];
    service.onDelta((delta) => deltas.push(delta));

    await registry.register(serviceRegistration(
      extensibleServiceSchema,
      [{ slotPath: "/plugins", accepts: "object" }],
    ));
    deltas.length = 0;
    await registry.register({
      serviceId: "billing",
      providerId: "tax",
      slotPath: "/plugins",
      environment: "test",
      owner: owner("tax"),
      schema: { ...fragmentSchema, required: ["providerEnabled"] },
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ action: "remove", key: "billing" });
    deltas.length = 0;
    await service.set("platform", "billing.plugins.tax.providerEnabled", true);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      action: "set",
      key: "billing",
      value: { plugins: { tax: { providerEnabled: true } } },
    });
  });

  test("a valid fragment cannot publish beneath an invalid parent", async () => {
    const provider = createTestProvider("p1", "platform", {
      billing: { plugins: { tax: { providerEnabled: true } } },
    });
    const service = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    const deltas = [];
    service.onDelta((delta) => deltas.push(delta));

    await registry.register(serviceRegistration({
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string" },
        plugins: { type: "object" },
      },
      additionalProperties: false,
    }, [{ slotPath: "/plugins", accepts: "object" }]));
    await registry.register({
      serviceId: "billing",
      providerId: "tax",
      slotPath: "/plugins",
      environment: "test",
      owner: owner("tax"),
      schema: { ...fragmentSchema, required: ["providerEnabled"] },
    });

    expect(deltas.map((delta) => [delta.action, delta.key])).toEqual([
      ["remove", "billing"],
      ["remove", "billing"],
    ]);
  });

  test("base and scoped source mutations project only their affected contexts", async () => {
    const base = createTestProvider("base", "platform", {
      billing: { mode: { _weaver: "mount", source: "shared.mode" } },
      shared: { mode: "prod" },
    });
    const tenant = createTestProvider("tenant", "tenant:acme", {
      shared: { mode: "test" },
    });
    const service = await createWeaverConfigService({
      providers: [base, tenant],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService: service });
    await service.get("shared.mode", {
      scopePath: [{ scopeId: "tenant", value: "acme" }],
    });
    await registry.register(serviceRegistration(serviceSchema));
    const deltas = [];
    service.onDelta((delta) => deltas.push(delta));

    await service.set("tenant:acme", "shared.mode", 42);
    expect(deltas.map((delta) => [delta.action, delta.layer, delta.key])).toEqual([
      ["remove", "tenant:acme", "billing"],
      ["set", "tenant:acme", "shared.mode"],
    ]);
    deltas.length = 0;
    await service.set("tenant:acme", "shared.mode", "test");
    expect(deltas[0]).toMatchObject({
      action: "set",
      layer: "tenant:acme",
      key: "billing",
      value: { mode: "test" },
    });
    deltas.length = 0;

    await service.set("platform", "shared.mode", "prod");
    expect(deltas.filter((delta) => delta.key === "billing").map((delta) => delta.layer)).toEqual([
      "tenant:acme",
      "weaver-effective",
    ]);
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
    const { provider, registry, service } = await makeRegisteredService({
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
    await expect(service.get("billing.mode")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(provider.entries().billing.mode).toBe("test");
  });
});
