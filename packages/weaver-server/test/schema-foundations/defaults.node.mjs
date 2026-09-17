import assert from "node:assert/strict";
import { test } from "node:test";
import { materializeConfigurationDefaults, validateConfigurationDefaults, validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import { createRestAdapter } from "../../src/transport/rest-adapter.ts";
import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
import { createSSEAdapter } from "../../src/transport/sse-adapter.ts";
import { fixture, owner, registration, validateCanonicalSchema } from "./fixtures.mjs";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";

const port = { type: "integer", default: 80 };
const object = { type: "object", required: ["port"], properties: { port } };
const sseData = (message) => JSON.parse(message.split("\n").find((line) => line.startsWith("data: ")).slice(6));

test("defaults fill absent own properties, never invent parents or array length, and clone everything", () => {
  const schema = { type: "object", properties: {
    absent: object, explicit: { ...object, default: {} }, existing: object,
    list: { type: "array", minItems: 3, items: object },
    tuple: { type: "array", items: [object, object] },
    nullable: { type: ["object", "null"], default: {}, properties: { port } },
    flag: { type: "boolean", default: true }, zero: port, empty: { type: "string", default: "x" },
    optionalWithoutDefault: { type: "string" },
  } };
  const input = { existing: {}, list: [{ port: 1 }, {}], tuple: [{}], nullable: null, flag: false, zero: 0, empty: "" };
  const before = structuredClone(input);
  const schemaBefore = structuredClone(schema);
  const result = materializeConfigurationDefaults(schema, input);
  assert.deepEqual(result, { ...input, explicit: { port: 80 }, existing: { port: 80 }, list: [{ port: 1 }, { port: 80 }], tuple: [{ port: 80 }] });
  assert.equal(validateEffectiveConfiguration(schema, result).valid, false); // minItems remains unsatisfied
  assert.deepEqual(input, before);
  assert.deepEqual(schema, schemaBefore);
  result.explicit.port = 2;
  assert.deepEqual(materializeConfigurationDefaults(schema, input).explicit, { port: 80 });
  assert.deepEqual(materializeConfigurationDefaults(object, { port: null }), { port: null });
  assert.equal(validateEffectiveConfiguration(object, materializeConfigurationDefaults(object, { port: null })).valid, false);
  assert.equal(materializeConfigurationDefaults(object, { port: undefined }).port, undefined);
  assert.equal(validateConfigurationDefaults(schema).valid, true);
});

for (const profile of ["memory", "fs-restart"]) {
  test(`invalid optional recursive defaults rejected before registration/hydration (${profile})`, async () => {
    const { registry, writes } = await fixture(undefined, profile);
    const invalid = { type: "string", default: 80 };
    const branches = [
      { type: "object", properties: { unused: invalid } },
      { type: "object", properties: { unused: { type: "array", items: invalid } } },
      { type: "object", patternProperties: { "^unused$": invalid } },
      { type: "object", additionalProperties: invalid },
      { type: "object", properties: { unused: { ...object, default: { port: null } } } },
    ];
    for (const schema of branches) {
      const result = await registry.register(registration(schema));
      assert.equal(result.success, false);
      assert.equal(result.error.code, "VALIDATION_ERROR");
      assert.throws(() => validateCanonicalSchema(schema), /default/i);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(registry.listAll(), {});
    await registry.register(registration({ type: "object" }, [{ slotPath: "/plugins", accepts: "object" }]));
    const before = writes.length;
    for (const schema of branches) {
      const result = await registry.register({ serviceId: "svc", environment: "dev", owner, providerId: "bad", slotPath: "/plugins", schema });
      assert.equal(result.success, false);
      assert.equal(result.error.code, "VALIDATION_ERROR");
    }
    assert.equal(writes.length, before);
  });
}

test("the defaulted object is delivered through core, REST, SCOMP, SSE snapshots and deltas without read writes", async () => {
  const { configService, registry, writes, data, activate } = await fixture();
  assert.equal((await registry.register(registration(object))).success, true);
  await activate();
  const deltas = [];
  const unsubscribe = configService.onDelta((delta) => deltas.push(delta));
  const snapshot = await configService.resolveAll();
  assert.deepEqual(snapshot.entries, { svc: { port: 80 } });
  assert.equal(await configService.get("svc.port"), 80);
  assert.equal((await configService.validateRegisteredEffective("/svc", { schemaRegistry: registry })).valid, true);
  assert.deepEqual(await configService.getNamespace("svc"), { port: 80 });
  const rest = createRestAdapter({ configService });
  const response = await rest.handleRequest("GET", "/v1/config", { params: {}, query: {}, headers: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.entries, snapshot.entries);
  const scomp = createWeaverScompService({ configService, schemaRegistry: registry, scopeManager: {} });
  assert.deepEqual((await scomp.router["weaver-config-v1.resolveAll"].handler({})).entries, snapshot.entries);
  const sse = createSSEAdapter({ configService });
  const client = await sse.createClient();
  assert.deepEqual(sseData(client.messages[0]).entries, snapshot.entries);
  assert.deepEqual(writes, []);
  assert.deepEqual(data, { svc: {} });
  snapshot.entries.svc.port = 999;
  assert.equal(await configService.get("svc.port"), 80);
  assert.equal((await configService.set("platform", "svc", {})).success, true);
  assert.deepEqual(deltas.at(-1).value, { port: 80 });
  assert.deepEqual(sseData(client.messages.at(-1)).value, { port: 80 });
  client.close();
  unsubscribe();
});

test("registration owns default values and rejects non-JSON defaults", async () => {
  const { registry, configService, activate } = await fixture();
  const child = { ...object, default: {} };
  await registry.register(registration({ type: "object", properties: { child } }));
  await activate();
  child.default.port = "corrupted";
  assert.equal(await configService.get("svc.child.port"), 80);
  for (const value of [new Date(), Infinity, undefined, () => 1]) {
    const result = await registry.register(registration({ type: "object", properties: { optional: { type: "object", default: value } } }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, "VALIDATION_ERROR");
  }
});

test("cold scope defaults inherit without crossing base/scope or provider boundaries", async () => {
  const scoped = createInMemoryStorageProvider({ id: "tenant", layer: "tenant" });
  await scoped.writeLayer("tenant:one", "svc", { port: 0 });
  await scoped.writeLayer("tenant:two", "svc", {});
  const { configService, registry, data, writes, activate } = await fixture(undefined, "memory", [scoped], ["one", "two"].map((value) => [{ scopeId: "tenant", value }]));
  await registry.register(registration(object));
  await activate();
  const scopePath = [{ scopeId: "tenant", value: "one" }];
  assert.equal(await configService.get("svc.port", { scopePath }), 0);
  assert.equal(await configService.get("svc.port", { scopePath: [{ scopeId: "tenant", value: "two" }] }), 80);
  assert.equal(await configService.get("svc.port"), 80);
  assert.deepEqual(data, { svc: {} });
  assert.deepEqual(writes, []);
});
