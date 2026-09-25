import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { buildSchemaPatch } from "../../src/core/config-service-schema-patches.ts";
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

function runArrayPatchMatrix() {
  const scalarSchema = { type: "array", items: { type: "string" } };
  const nestedSchema = {
    type: "array",
    items: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  };
  return [
    buildSchemaPatch([], ["0"], "append", scalarSchema),
    buildSchemaPatch(new Array(1), ["0"], "hole", scalarSchema),
    buildSchemaPatch([], ["0", "name"], "append", nestedSchema),
    buildSchemaPatch(new Array(1), ["0", "name"], "hole", nestedSchema),
    buildSchemaPatch(["old"], ["0"], "dense", scalarSchema),
  ];
}

function expectPrototypeDescriptors(target, descriptors) {
  expect(Reflect.ownKeys(target)).toEqual(Reflect.ownKeys(descriptors));
  for (const key of Reflect.ownKeys(descriptors)) {
    expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(descriptors[key]);
  }
}

function expectArrayPatchMatrix(results) {
  expect(results).toEqual([
    { success: true, value: ["append"] },
    { success: true, value: ["hole"] },
    { success: true, value: [{ name: "append" }] },
    { success: true, value: [{ name: "hole" }] },
    { success: true, value: ["dense"] },
  ]);
  for (const result of results) {
    expect(result.value).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(result.value, "0")).toEqual({
      configurable: true,
      enumerable: true,
      value: result.value[0],
      writable: true,
    });
    expect(Object.getPrototypeOf(result.value)).toBe(Array.prototype);
  }
  expect(Object.getPrototypeOf(results[2].value[0])).toBe(Object.prototype);
  expect(Object.getPrototypeOf(results[3].value[0])).toBe(Object.prototype);
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

function setRegistered(service, registry, path, value) {
  return service.setRegisteredObject("platform", path, value, {
    schemaRegistry: registry,
  });
}

function patchRegistered(service, registry, path, value) {
  return service.patchRegisteredPath("platform", path, value, {
    schemaRegistry: registry,
  });
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
    items: { type: "array", items: { type: "string" } },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          values: { type: "array", items: { type: "string" } },
        },
      },
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

    const partial = await setRegistered(service, registry, "/billing", { limit: 10 });
    const acceptedEntries = await providerEntries(provider);
    const acceptedRevision = service.revision;
    const invalid = await setRegistered(service, registry, "/billing", { mode: "qa" });

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

    const valid = await setRegistered(service, registry, "/billing/plugins/tax", {
      providerEnabled: true,
    });
    const acceptedEntries = await providerEntries(provider);
    const acceptedRevision = service.revision;
    const invalid = await setRegistered(service, registry, "/billing/plugins/tax", {
      providerEnabled: "yes",
    });

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

    const result = await patchRegistered(service, registry, "/billing/limit", 5);

    expect(result).toEqual({ success: true });
    expect(provider.writes).toEqual([
      { key: "billing", value: { mode: "test", limit: 5 } },
    ]);
    expect(await providerEntries(provider)).toEqual({
      billing: { mode: "test", limit: 5 },
    });
    expect(await service.get("billing.limit")).toBe(5);
  });

  test("prototype-colliding properties persist under open registered schemas", async () => {
    const openProvider = createTestProvider("open", "platform", { service: {} });
    const openService = await createWeaverConfigService({
      providers: [openProvider],
      environment: "test",
    });
    const openRegistry = createSchemaRegistry({ configService: openService });
    await openRegistry.register(
      serviceRegistration(
        { type: "object", properties: {}, additionalProperties: true },
        [],
        "service",
      ),
    );

    const openResult = await patchRegistered(
      openService,
      openRegistry,
      "/service/toString",
      "allowed",
    );
    const stored = (await providerEntries(openProvider)).service;

    expect(openResult).toEqual({ success: true });
    expect(openProvider.writes).toHaveLength(1);
    expect(openProvider.writes[0].key).toBe("service");
    expect(Object.keys(stored)).toEqual(["toString"]);
    expect(Object.getOwnPropertyDescriptor(stored, "toString")).toEqual({
      configurable: true,
      enumerable: true,
      value: "allowed",
      writable: true,
    });
  });

  test("prototype-colliding properties have zero effects under closed schemas", async () => {
    const closedEntries = { closed: {} };
    const closedProvider = createTestProvider("closed", "platform", closedEntries);
    const closedService = await createWeaverConfigService({
      providers: [closedProvider],
      environment: "test",
    });
    const closedRegistry = createSchemaRegistry({ configService: closedService });
    await closedRegistry.register(
      serviceRegistration(
        { type: "object", properties: {}, additionalProperties: false },
        [],
        "closed",
      ),
    );
    const closedRevision = closedService.revision;

    const closedResult = await patchRegistered(
      closedService,
      closedRegistry,
      "/closed/toString",
      "blocked",
    );

    expect(closedResult).toEqual(
      schemaFailure("/closed/toString", "/closed", {
        code: "unknown-property",
        path: "$.closed.toString",
        segments: ["closed", "toString"],
        message: 'Unknown property "toString" is not allowed',
      }),
    );
    await expectNoEffects(
      closedProvider,
      closedService,
      closedEntries,
      closedRevision,
    );
  });

  test("invalid type, unknown property, enum, and nested shape patches are rejected", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test" },
    });
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const invalidType = await patchRegistered(service, registry, "/billing/limit", "high");
    const unknown = await patchRegistered(service, registry, "/billing/unknown", true);
    const invalidEnum = await patchRegistered(service, registry, "/billing/mode", "qa");
    const invalidNested = await patchRegistered(service, registry, "/billing/nested", {
      enabled: "yes",
    });
    const anchorPatch = await patchRegistered(service, registry, "/billing", {});

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
        const result = await patchRegistered(service, registry, path, true);

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

    const protectedRoot = await setRegistered(service, registry, "/_weaver", {});
    const bracketRoot = await setRegistered(service, registry, "[_weaver]", {});
    const unregistered = await setRegistered(service, registry, "/unknown", {});
    const malformed = await setRegistered(service, registry, "billing", {});
    const descendant = await setRegistered(service, registry, "/billing/limit", 4);

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

    const result = await patchRegistered(service, registry, "/billing/mode", "prod");

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

    const result = await patchRegistered(service, registry, "/billing/limit", 5);

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

  test("array patches update existing items and append dense values", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: {
        mode: "test",
        items: ["old"],
        groups: [{ values: ["first"] }],
      },
    });

    const update = await patchRegistered(service, registry, "/billing/items/0", "new");
    const append = await patchRegistered(service, registry, "/billing/items/1", "second");
    const nestedAppend = await patchRegistered(
      service,
      registry,
      "/billing/groups/0/values/1",
      "nested",
    );

    expect([update, append, nestedAppend]).toEqual([
      { success: true },
      { success: true },
      { success: true },
    ]);
    expect(provider.writes).toHaveLength(3);
    const entries = await providerEntries(provider);
    expect(entries.billing.items).toEqual(["new", "second"]);
    expect(entries.billing.groups[0].values).toEqual(["first", "nested"]);
    expect(Object.hasOwn(entries.billing.items, 0)).toBe(true);
    expect(Object.hasOwn(entries.billing.items, 1)).toBe(true);
    expect(Object.hasOwn(entries.billing.groups[0].values, 0)).toBe(true);
    expect(Object.hasOwn(entries.billing.groups[0].values, 1)).toBe(true);
  });

  test("array patches append index zero to an empty array", async () => {
    const { provider, registry, service } = await makeRegisteredService({
      billing: { mode: "test", items: [] },
    });

    const result = await patchRegistered(service, registry, "/billing/items/0", "first");

    expect(result).toEqual({ success: true });
    expect(provider.writes).toHaveLength(1);
    expect((await providerEntries(provider)).billing.items).toEqual(["first"]);
  });

  test("array patch writes ignore inherited numeric accessors", () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    const arrayPrototypeDescriptors = Object.getOwnPropertyDescriptors(Array.prototype);
    const objectPrototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    let getterCalls = 0;
    let setterCalls = 0;
    let installed = false;
    let restored = false;
    let results;

    try {
      installed = Reflect.defineProperty(Array.prototype, "0", {
        configurable: true,
        get() {
          getterCalls += 1;
          return "inherited";
        },
        set() {
          setterCalls += 1;
        },
      });
      if (installed) results = runArrayPatchMatrix();
    } finally {
      const indexRestored = previousDescriptor === undefined
        ? Reflect.deleteProperty(Array.prototype, "0")
        : Reflect.defineProperty(Array.prototype, "0", previousDescriptor);
      const lengthRestored = Reflect.defineProperty(
        Array.prototype,
        "length",
        arrayPrototypeDescriptors.length,
      );
      restored = indexRestored && lengthRestored;
    }

    expect(installed).toBe(true);
    expect(restored).toBe(true);
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
    expectPrototypeDescriptors(Array.prototype, arrayPrototypeDescriptors);
    expectPrototypeDescriptors(Object.prototype, objectPrototypeDescriptors);
    expectArrayPatchMatrix(results);
  });

  test("missing containers follow object-key and array schemas", async () => {
    const provider = createTestProvider("p1", "platform", { service: {} });
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration({
      type: "object",
      additionalProperties: false,
      properties: {
        map: {
          type: "object",
          additionalProperties: false,
          properties: {
            0: { type: "object", properties: {
              1: { type: "object", properties: { name: { type: "string" } } },
            } },
          },
        },
        list: { type: "array", items: { type: "string" } },
      },
    }, [], "service"));

    const objectResult = await patchRegistered(service, registry, "/service/map/0/1/name", "zero");
    const arrayResult = await patchRegistered(service, registry, "/service/list/0", "first");
    const stored = (await providerEntries(provider)).service;

    expect([objectResult, arrayResult]).toEqual([{ success: true }, { success: true }]);
    expect(provider.writes).toHaveLength(2);
    expect(stored).toEqual({ map: { 0: { 1: { name: "zero" } } }, list: ["first"] });
    expect(Array.isArray(stored.map)).toBe(false);
    expect(Array.isArray(stored.list)).toBe(true);
  });

  test("patch cloning preserves reserved own data properties", async () => {
    const data = JSON.parse('{"__proto__":{"marker":"proto"},"constructor":{"marker":"constructor"},"prototype":{"marker":"prototype"}}');
    const provider = createTestProvider("p1", "platform", { service: data });
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(extensibleServiceSchema, [], "service"));

    const result = await patchRegistered(service, registry, "/service/other", true);
    const stored = (await providerEntries(provider)).service;

    expect(result).toEqual({ success: true });
    expect(provider.writes).toHaveLength(1);
    expect(Object.keys(stored)).toEqual(["__proto__", "constructor", "prototype", "other"]);
    expect(stored.__proto__).toEqual({ marker: "proto" });
    expect(stored.constructor).toEqual({ marker: "constructor" });
    expect(stored.prototype).toEqual({ marker: "prototype" });
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.prototype.marker).toBe(undefined);
  });

  test("out-of-range array patches reject before provider effects", async () => {
    const initialEntries = { billing: { mode: "test", items: [] } };
    const { provider, registry, service } = await makeRegisteredService(initialEntries);
    const initialRevision = service.revision;

    const result = await patchRegistered(service, registry, "/billing/items/2", "blocked");

    expect(result).toEqual(
      writeFailure(
        "VALIDATION_ERROR",
        "Array patch index 2 exceeds current length 0",
        {
          path: "/billing/items/2",
          anchorPath: "/billing",
          environment: "test",
          index: 2,
          length: 0,
        },
      ),
    );
    await expectNoEffects(provider, service, initialEntries, initialRevision);
  });

  test.each(["01", "4294967295"])(
    "noncanonical array index %s rejects before provider effects",
    async (index) => {
      const initialEntries = { billing: { mode: "test", items: [] } };
      const { provider, registry, service } = await makeRegisteredService(initialEntries);
      const initialRevision = service.revision;

      const result = await patchRegistered(
        service,
        registry,
        `/billing/items/${index}`,
        "blocked",
      );

      expect(result.error).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Configuration does not match registered schema",
        details: {
          path: `/billing/items/${index}`,
          anchorPath: "/billing",
          environment: "test",
          errors: [expect.objectContaining({ code: "invalid-path" })],
        },
      });
      await expectNoEffects(provider, service, initialEntries, initialRevision);
    },
  );

  test("pre-existing sparse arrays reject before provider effects", async () => {
    const items = new Array(2);
    items[1] = "present";
    const initialEntries = { billing: { mode: "test", items } };
    const { provider, registry, service } = await makeRegisteredService(initialEntries);
    const persistedEntries = await providerEntries(provider);
    const initialRevision = service.revision;

    const result = await patchRegistered(service, registry, "/billing/items/1", "blocked");

    expect(result.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        errors: [
          expect.objectContaining({
            code: "invalid-value",
            path: "$.billing.items[0]",
          }),
        ],
      },
    });
    await expectNoEffects(provider, service, persistedEntries, initialRevision);
  });

  test("cyclic registered writes reject without provider effects", async () => {
    const provider = createTestProvider("p1", "platform", { service: {} });
    const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
    const registry = createSchemaRegistry({ configService: service });
    await registry.register(serviceRegistration(extensibleServiceSchema, [], "service"));
    const initialEntries = await providerEntries(provider);
    const initialRevision = service.revision;
    const cyclic = {};
    cyclic.self = cyclic;

    const objectResult = await setRegistered(service, registry, "/service", cyclic);
    const patchResult = await patchRegistered(service, registry, "/service/cyclic", cyclic);

    expect(objectResult.error.details.errors[0]).toMatchObject({
      code: "invalid-value",
      path: "$.service.self",
    });
    expect(patchResult.error.details.errors[0]).toMatchObject({
      code: "invalid-value",
      path: "$.service.cyclic.self",
    });
    await expectNoEffects(provider, service, initialEntries, initialRevision);
  });

  test("builds depth-5000 patches iteratively", () => {
    const root = {};
    const segments = Array.from({ length: 5_000 }, () => "next");
    let cursor = root;
    for (let index = 0; index < segments.length - 1; index++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    cursor.next = "old";

    const result = buildSchemaPatch(root, segments, "new", undefined);

    expect(result.success).toBe(true);
    if (!result.success) return;
    cursor = result.value;
    for (const segment of segments) cursor = cursor[segment];
    expect(cursor).toBe("new");
  });
});
