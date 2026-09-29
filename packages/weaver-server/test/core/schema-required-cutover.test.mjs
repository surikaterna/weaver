import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";

const owner = { name: "Billing", contact: "billing@example.com" };

async function setup(schema, entries = {}, environment = "dev") {
  const provider = createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: entries });
  const effects = { writes: 0, removes: 0, flushes: 0, deltas: [] };
  const write = provider.write.bind(provider);
  const remove = provider.remove.bind(provider);
  provider.write = async (...args) => { effects.writes++; return write(...args); };
  provider.remove = async (...args) => { effects.removes++; return remove(...args); };
  provider.dirty = true;
  provider.flush = async () => { effects.flushes++; };
  const service = await createWeaverConfigService({ providers: [provider], environment, flushDebounceMs: 0 });
  service.onDelta((delta) => effects.deltas.push(delta));
  const registry = createSchemaRegistry({ configService: service });
  const registered = await registry.register({
    serviceId: "billing", environment, owner, schema, fragmentSlots: [],
  });
  expect(registered.success, registered.error?.message).toBe(true);
  return { service, provider, registry, effects };
}

async function denial(harness, operation, code) {
  const { service, provider, effects } = harness;
  await service.flush();
  const before = structuredClone((await provider.load()).entries);
  const revision = service.revision;
  const baseline = { ...effects, deltas: effects.deltas.length };
  const result = await operation();
  expect(result.error?.code).toBe(code);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await provider.load()).entries).toEqual(before);
  expect(service.revision).toBe(revision);
  expect({ ...effects, deltas: effects.deltas.length }).toEqual(baseline);
}

function billing(additionalProperties) {
  return {
    type: "object",
    properties: {
      mode: { type: "string" },
      items: { type: "array", items: { type: "string" } },
      map: { type: "object", properties: { "0": { type: "string" } }, additionalProperties: false },
    },
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
  };
}

describe("server-bound structural admission", () => {
  test.each([true, undefined, false])("closed/default invalid legacy siblings block declared writes when additionalProperties=%s", async (additional) => {
    const harness = await setup(billing(additional), {
      billing: { mode: "old", unknown: "legacy" }, legacy: { readable: true },
    });
    expect(await harness.service.get("legacy.readable")).toBe(true);
    expect(await harness.service.get("billing.unknown")).toBe("legacy");
    if (additional === true) {
      expect((await harness.service.set("platform", "billing.mode", "new")).success).toBe(true);
    } else {
      await denial(harness, () => harness.service.set("platform", "billing.mode", "new"), "VALIDATION_ERROR");
      await denial(harness, () => harness.service.patchRegisteredPath("platform", "/billing/mode", "new", {
        schemaRegistry: harness.registry,
      }), "SCHEMA_NOT_REGISTERED");
    }
    await denial(harness, () => harness.service.set("platform", "billing.unknown", "new"), "SCHEMA_NOT_REGISTERED");
    await denial(harness, () => harness.service.remove("platform", "billing.unknown"), "SCHEMA_NOT_REGISTERED");
    await denial(harness, () => harness.service.set("platform", "billing", { mode: "ok", surprise: true }), "SCHEMA_NOT_REGISTERED");
    await denial(harness, () => harness.service.set("platform", "legacy.readable", false), "SCHEMA_NOT_REGISTERED");
    expect((await harness.service.set("platform", "billing", { mode: "clean" })).success).toBe(true);
    expect((await harness.provider.load()).entries.billing).toEqual({ mode: "clean" });
    expect(await harness.service.get("legacy.readable")).toBe(true);
  });

  test.each([
    { "billing.mode": "new", "billing.items": [] },
    { "billing.items": [], "billing.mode": "new" },
  ])("combined batch cannot preserve a schema-invalid legacy sibling", async (entries) => {
    const harness = await setup(billing(false), { billing: { mode: "old", rogue: "legacy" } });
    await denial(harness, () => harness.service.setMany("platform", entries), "VALIDATION_ERROR");
    expect(await harness.service.get("billing.rogue")).toBe("legacy");
    expect((await harness.service.set("platform", "billing", { mode: "clean" })).success).toBe(true);
  });

  test("generic array indices never reach the provider while whole arrays and numeric object keys work", async () => {
    const harness = await setup(billing(false), { billing: { mode: "ok", items: ["old"], map: { "0": "before" } } });
    await denial(harness, () => harness.service.set("platform", "billing.items[0]", "bad"), "UNSUPPORTED_OPERATION");
    await denial(harness, () => harness.service.remove("platform", "billing.items[0]"), "UNSUPPORTED_OPERATION");
    expect((await harness.provider.load()).entries.billing.items).toEqual(["old"]);
    expect((await harness.service.set("platform", "billing.map.0", "after")).success).toBe(true);
    expect((await harness.service.set("platform", "billing", { mode: "ok", items: ["next"], map: { "0": "after" } })).success).toBe(true);
    expect((await harness.provider.load()).entries.billing.items).toEqual(["next"]);
  });

  test("an actual array remains unsupported even if the attempted write changes the winning branch", async () => {
    const branch = {
      type: "object", properties: {
        kind: { type: "string", const: "items" },
        items: { type: "array", items: { type: "string" } },
      }, additionalProperties: false,
    };
    const schema = {
      type: "object", properties: { kind: { type: "string" }, items: { type: "array", items: { type: "string" } } },
      anyOf: [branch], additionalProperties: false,
    };
    const harness = await setup(schema, { billing: { kind: "items", items: ["old"] } });
    await denial(harness, () => harness.service.set("platform", "billing.items[0]", "new"), "UNSUPPORTED_OPERATION");
    expect((await harness.provider.load()).entries.billing.items).toEqual(["old"]);
  });

  test("registered array patches persist an anchor object and retain arrays after reload", async () => {
    const harness = await setup(billing(false), { billing: { mode: "ok", items: ["old"] } });
    const revision = harness.service.revision;
    const result = await harness.service.patchRegisteredPath("platform", "/billing/items/1", "new", {
      schemaRegistry: harness.registry,
    });
    expect(result.success).toBe(true);
    expect(harness.effects.writes).toBe(1);
    expect(harness.effects.deltas.at(-1)).toMatchObject({ key: "billing", value: { mode: "ok", items: ["old", "new"] } });
    expect(harness.service.revision).not.toBe(revision);
    await harness.service.reloadProvider("platform");
    expect((await harness.provider.load()).entries.billing.items).toEqual(["old", "new"]);
    await denial(harness, () => harness.service.patchRegisteredPath("platform", "/billing/items/3", "hole", {
      schemaRegistry: harness.registry,
    }), "VALIDATION_ERROR");
  });

  test("patterns and schema-valued dynamic keys admit only explicitly governed nested payloads", async () => {
    const schema = {
      type: "object",
      patternProperties: { "^flag_": { type: "boolean" } },
      additionalProperties: { type: "object", properties: { value: { type: "integer" } }, additionalProperties: false },
    };
    const harness = await setup(schema);
    expect((await harness.service.set("platform", "billing.flag_on", true)).success).toBe(true);
    expect((await harness.service.set("platform", "billing.dynamic", { value: 3 })).success).toBe(true);
    await denial(harness, () => harness.service.set("platform", "billing.dynamic", { value: 3, extra: 1 }), "SCHEMA_NOT_REGISTERED");
    await denial(harness, () => harness.service.set("platform", "billing.other", true), "VALIDATION_ERROR");
    await denial(harness, () => harness.service.set("platform", "billing.flag_on", "yes"), "VALIDATION_ERROR");
  });

  test("mixed invalid batches and alias/ancestor collisions reject before the first write", async () => {
    const harness = await setup(billing(true), { billing: { mode: "ok" } });
    for (const entries of [
      { "billing.mode": "next", "billing.unknown": "bad" },
      { "billing.unknown": "bad", "billing.mode": "next" },
    ]) await denial(harness, () => harness.service.setMany("platform", entries), "SCHEMA_NOT_REGISTERED");
    for (const entries of [
      { "billing.mode": "next", "billing.items": 5 },
      { "billing.items": 5, "billing.mode": "next" },
    ]) await denial(harness, () => harness.service.setMany("platform", entries), "VALIDATION_ERROR");
    await denial(harness, () => harness.service.setMany("platform", { "billing.mode": "a", "billing[mode]": "b" }), "VALIDATION_ERROR");
    await denial(harness, () => harness.service.setMany("platform", { billing: { mode: "a" }, "billing.mode": "b" }), "VALIDATION_ERROR");
    await denial(harness, () => harness.service.setMany("platform", { "billing.mode": "a", "billing.items[0]": "bad" }), "UNSUPPORTED_OPERATION");
    expect((await harness.service.setMany("platform", { "billing.mode": "next" })).success).toBe(true);
  });

  test("batch admission checks one full combined candidate before sequential provider writes", async () => {
    const schema = { ...billing(false), required: ["mode", "items"] };
    const harness = await setup(schema, { billing: {} });
    const result = await harness.service.setMany("platform", {
      "billing.mode": "ready", "billing.items": ["one"],
    });
    expect(result.success).toBe(true);
    expect((await harness.provider.load()).entries.billing).toEqual({ mode: "ready", items: ["one"] });
    expect(harness.effects.writes).toBe(2);
  });

  test("provider failure after a successful batch preflight reports a partial commit honestly", async () => {
    const harness = await setup(billing(false), { billing: { mode: "before", items: [] } });
    const providerWrite = harness.provider.write.bind(harness.provider);
    let attempts = 0;
    harness.provider.write = async (key, value) => {
      attempts++;
      if (attempts === 2) return { success: false, error: { code: "DISK_ERROR", message: "failed after first write" } };
      return providerWrite(key, value);
    };
    const revision = harness.service.revision;
    const result = await harness.service.setMany("platform", {
      "billing.mode": "first", "billing.items": ["second"],
    });
    expect(result.error?.code).toBe("DISK_ERROR");
    expect(attempts).toBe(2);
    expect(harness.service.revision).not.toBe(revision);
    expect(harness.effects.deltas).toHaveLength(1);
    expect((await harness.provider.load()).entries.billing).toEqual({ mode: "first", items: [] });
  });

  test("a nonwinning anyOf/oneOf branch and not cannot grant authority", async () => {
    const text = { type: "object", properties: { kind: { type: "string", const: "text" }, value: { type: "string" } }, additionalProperties: true };
    const count = { type: "object", properties: { kind: { type: "string", const: "count" }, other: { type: "number" } }, additionalProperties: true };
    const schema = { type: "object", properties: { kind: { type: "string" } }, additionalProperties: true, anyOf: [text, count], oneOf: [text, count] };
    const harness = await setup(schema, { billing: { kind: "text" } });
    expect((await harness.service.set("platform", "billing.value", "yes")).success).toBe(true);
    await denial(harness, () => harness.service.set("platform", "billing.value", 2), "VALIDATION_ERROR");
    await denial(harness, () => harness.service.set("platform", "billing.other", 5), "SCHEMA_NOT_REGISTERED");
    const notOnly = await setup({ type: "object", additionalProperties: true, not: { type: "object", properties: { only: { type: "string" } } } });
    await denial(notOnly, () => notOnly.service.set("platform", "billing.only", "bad"), "SCHEMA_NOT_REGISTERED");
  });

  test("allOf siblings can declare a path but every constraint still applies", async () => {
    const schema = {
      type: "object", additionalProperties: true,
      allOf: [
        { type: "object", properties: { mode: { type: "string" } }, additionalProperties: true },
        { type: "object", maxProperties: 1, additionalProperties: true },
      ],
    };
    const harness = await setup(schema);
    expect((await harness.service.set("platform", "billing.mode", "valid")).success).toBe(true);
    await denial(harness, () => harness.service.set("platform", "billing.other", 2), "SCHEMA_NOT_REGISTERED");
    await denial(harness, () => harness.service.set("platform", "billing.mode", 2), "VALIDATION_ERROR");
  });

  test("overlapping fragment and parent declarations both constrain a dedicated write", async () => {
    const fragment = { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false };
    const parent = {
      type: "object", properties: {
        mode: { type: "string" },
        plugins: { type: "object", properties: { tax: fragment }, additionalProperties: false },
      }, additionalProperties: false,
    };
    const harness = await setup(parent, { billing: { mode: "ok" } });
    const registration = await harness.registry.register({
      serviceId: "billing", environment: "dev", owner, schema: parent,
      fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
    });
    expect(registration.success).toBe(true);
    expect((await harness.registry.register({
      serviceId: "billing", providerId: "tax", slotPath: "/plugins",
      environment: "dev", owner, schema: fragment,
    })).success).toBe(true);
    expect((await harness.service.setRegisteredObject("platform", "/billing/plugins/tax", { enabled: true }, {
      schemaRegistry: harness.registry,
    })).success).toBe(true);
    await denial(harness, () => harness.service.setRegisteredObject("platform", "/billing/plugins/tax", { enabled: true, rogue: 1 }, {
      schemaRegistry: harness.registry,
    }), "SCHEMA_NOT_REGISTERED");
    expect((await harness.provider.load()).entries.billing.plugins.tax).toEqual({ enabled: true });
  });

  test("an explicit environment cannot replace the bound default or authorize another registry", async () => {
    const harness = await setup(billing(false), { billing: { mode: "ok" } });
    await denial(harness, () => harness.service.set("platform", "billing.mode", "other", { environment: "other" }), "SCHEMA_NOT_REGISTERED");
    await denial(harness, () => harness.service.setRegisteredObject("platform", "/billing", { mode: "other" }, {
      schemaRegistry: harness.registry, environment: "other",
    }), "SCHEMA_NOT_REGISTERED");
  });

  test("a caller-selected scope cannot hide an invalid base effective candidate", async () => {
    const platform = createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: { billing: {} } });
    const tenant = createInMemoryStorageProvider({ id: "tenant", layer: "tenant:other", initialEntries: { billing: { mode: "ok" } } });
    let writes = 0;
    const original = platform.write.bind(platform);
    platform.write = async (...args) => { writes++; return original(...args); };
    const service = await createWeaverConfigService({ providers: [platform, tenant], environment: "dev" });
    const registry = createSchemaRegistry({ configService: service });
    const result = await registry.register({
      serviceId: "billing", environment: "dev", owner,
      schema: { ...billing(false), required: ["mode"] }, fragmentSlots: [],
    });
    expect(result.success).toBe(true);
    const revision = service.revision;
    const attempted = await service.set("platform", "billing.items", [], {
      scopePath: [{ scopeId: "tenant", value: "other" }],
    });
    expect(attempted.error?.code).toBe("VALIDATION_ERROR");
    expect(writes).toBe(0);
    expect(service.revision).toBe(revision);
    expect((await platform.load()).entries.billing).toEqual({});
  });

  test("unbound service fails closed while read-only legacy data stays visible", async () => {
    const provider = createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: { legacy: "readable" } });
    const service = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    expect(await service.get("legacy")).toBe("readable");
    const revision = service.revision;
    expect((await service.set("platform", "legacy", "no")).error?.code).toBe("INTERNAL_ERROR");
    expect(service.revision).toBe(revision);
    expect((await provider.load()).entries.legacy).toBe("readable");
  });

  test("submitted single, batch and dedicated objects cannot be mutated after preflight submission", async () => {
    const harness = await setup(billing(false));
    const object = { mode: "safe" };
    const pending = harness.service.set("platform", "billing", object);
    object.rogue = true;
    expect((await pending).success).toBe(true);
    expect((await harness.provider.load()).entries.billing).toEqual({ mode: "safe" });

    const entries = { "billing.mode": "batch" };
    const batch = harness.service.setMany("platform", entries);
    entries["billing.unknown"] = "late";
    expect((await batch).success).toBe(true);
    expect((await harness.provider.load()).entries.billing).toEqual({ mode: "batch" });

    const dedicated = { mode: "dedicated" };
    const request = harness.service.setRegisteredObject("platform", "/billing", dedicated, {
      schemaRegistry: harness.registry,
    });
    dedicated.rogue = "late";
    expect((await request).success).toBe(true);
    expect((await harness.provider.load()).entries.billing).toEqual({ mode: "dedicated" });
  });

  test("mutating a returned registry schema cannot expand bound write authority", async () => {
    const submittedSchema = billing(false);
    const harness = await setup(submittedSchema, { billing: { mode: "safe" } });
    submittedSchema.additionalProperties = true;
    const detail = harness.registry.getRegisteredSchema("/billing", "dev");
    detail.schema.additionalProperties = true;
    const schema = await harness.registry.getSchema("billing", "dev");
    schema.additionalProperties = true;
    const list = harness.registry.listAll();
    list["/billing:dev"].additionalProperties = true;
    await denial(harness, () => harness.service.set("platform", "billing.rogue", 1), "SCHEMA_NOT_REGISTERED");
  });

  test("many sibling keys and deep canonical paths preflight without changing provider state", async () => {
    const siblings = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`billing.map.k${index}`, "value"]));
    const harness = await setup({ type: "object", properties: {
      map: { type: "object", patternProperties: { "^k[0-9]+$": { type: "string" } }, additionalProperties: false },
    }, additionalProperties: false });
    await denial(harness, () => harness.service.setMany("platform", { ...siblings, "billing.map[k0]": "alias" }), "VALIDATION_ERROR");
    expect((await harness.service.setMany("platform", siblings)).success).toBe(true);
    expect(Object.keys((await harness.provider.load()).entries.billing.map)).toHaveLength(120);

    const segments = Array.from({ length: 60 }, (_, index) => `p${index}`);
    const deepSchema = segments.reduceRight((child, segment) => ({ type: "object", properties: { [segment]: child }, additionalProperties: false }), { type: "string" });
    const deep = await setup(deepSchema);
    const path = `billing.${segments.join(".")}`;
    await denial(deep, () => deep.service.setMany("platform", { [path]: "ok", [`billing[${segments[0]}].${segments.slice(1).join(".")}`]: "alias" }), "VALIDATION_ERROR");
    expect((await deep.service.setMany("platform", { [path]: "ok" })).success).toBe(true);
    expect(await deep.service.get(path)).toBe("ok");
  });

  test("combined anyOf and oneOf candidates must satisfy their winning branch", async () => {
    const text = { type: "object", properties: { kind: { type: "string", const: "text" }, value: { type: "string" } }, required: ["kind", "value"], additionalProperties: false };
    const count = { type: "object", properties: { kind: { type: "string", const: "count" }, value: { type: "number" } }, required: ["kind", "value"], additionalProperties: false };
    const harness = await setup({ type: "object", properties: { kind: { type: "string" }, value: { type: ["string", "number"] } }, anyOf: [text, count], oneOf: [text, count] });
    for (const entries of [
      { "billing.kind": "text", "billing.value": 3 },
      { "billing.value": 3, "billing.kind": "text" },
    ]) await denial(harness, () => harness.service.setMany("platform", entries), "SCHEMA_NOT_REGISTERED");
    expect((await harness.service.setMany("platform", { "billing.kind": "count", "billing.value": 3 })).success).toBe(true);
  });

  test("open objects do not authorize undeclared batch members; arrays remain unsupported", async () => {
    const harness = await setup(billing(true), { billing: { mode: "before", items: ["old"] } });
    for (const entries of [
      { "billing.mode": "next", "billing.rogue": "x" },
      { "billing.rogue": "x", "billing.mode": "next" },
    ]) await denial(harness, () => harness.service.setMany("platform", entries), "SCHEMA_NOT_REGISTERED");
    for (const entries of [
      { "billing.mode": "next", "billing.items[0]": "x" },
      { "billing.items.0": "x", "billing.mode": "next" },
    ]) await denial(harness, () => harness.service.setMany("platform", entries), "UNSUPPORTED_OPERATION");
    const ambiguous = await setup({ type: "object", properties: {
      value: { type: ["object", "array"], anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "object", properties: { "0": { type: "string" } } },
      ] },
    } });
    await denial(ambiguous, () => ambiguous.service.setMany("platform", { "billing.value.0": "x" }), "VALIDATION_ERROR");
  });

  test("scoped batch cannot use another tenant's required property to pass preflight", async () => {
    const platform = createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: { billing: {} } });
    const tenant = createInMemoryStorageProvider({ id: "tenant", layer: "tenant:other", initialEntries: { billing: { mode: "ok" } } });
    const service = await createWeaverConfigService({ providers: [platform, tenant], environment: "dev" });
    const registry = createSchemaRegistry({ configService: service });
    expect((await registry.register({ serviceId: "billing", environment: "dev", owner, schema: { ...billing(false), required: ["mode"] }, fragmentSlots: [] })).success).toBe(true);
    const revision = service.revision;
    const result = await service.setMany("platform", { "billing.items": [], "billing.map": { "0": "ok" } }, { scopePath: [{ scopeId: "tenant", value: "other" }] });
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect((await platform.load()).entries.billing).toEqual({});
    expect(service.revision).toBe(revision);
  });

  test("root payloads and overlapping fragments enforce both parent and child constraints", async () => {
    const fragment = { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false };
    const parent = { type: "object", properties: {
      mode: { type: "string" }, plugins: { type: "object", properties: { tax: fragment }, additionalProperties: false },
    }, additionalProperties: false };
    const harness = await setup(parent, { billing: { mode: "before" } });
    expect((await harness.registry.register({ serviceId: "billing", environment: "dev", owner, schema: parent,
      fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }] })).success).toBe(true);
    expect((await harness.registry.register({ serviceId: "billing", providerId: "tax", slotPath: "/plugins",
      environment: "dev", owner, schema: fragment })).success).toBe(true);
    for (const entries of [
      { billing: { mode: "next", plugins: { tax: { enabled: true, rogue: 1 } } } },
      { "billing.mode": "next", "billing.plugins.tax": { enabled: true, rogue: 1 } },
    ]) await denial(harness, () => harness.service.setMany("platform", entries), "SCHEMA_NOT_REGISTERED");
    expect((await harness.service.setMany("platform", { billing: { mode: "next", plugins: { tax: { enabled: true } } } })).success).toBe(true);
  });

  test("in-process registration, single writes and batches observe serialized admission", async () => {
    const harness = await setup(billing(false), { billing: { mode: "before" } });
    const submitted = [
      harness.service.setMany("platform", { "billing.mode": "batch" }),
      harness.service.set("platform", "billing.mode", "single"),
      harness.registry.register({ serviceId: "other", environment: "dev", owner, schema: { type: "object", properties: { mode: { type: "string" } }, additionalProperties: false }, fragmentSlots: [] }),
    ];
    const results = await Promise.all(submitted);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[2].success).toBe(true);
    expect((await harness.provider.load()).entries.billing.mode).toBe("single");
    expect((await harness.service.setMany("platform", { "other.mode": "registered" })).success).toBe(true);
  });
});
