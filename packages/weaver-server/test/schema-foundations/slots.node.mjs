import assert from "node:assert/strict";
import { test } from "node:test";
import { composeRegisteredServiceSchema, materializeConfigurationDefaults, validateEffectiveConfiguration, validatePartialConfiguration } from "@weaver-conf/config-engine";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { fixture, owner, registration } from "./fixtures.mjs";
import { projectCanonicalRegistrations } from "../../src/core/canonical-projection.ts";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";

const slots = [{ slotPath: "/plugins", accepts: "object" }];
const schema = { type: "object", properties: { enabled: { type: "boolean", default: false } }, required: ["enabled"] };
const fragment = { serviceId: "svc", providerId: "analytics", environment: "dev", owner, slotPath: "/plugins", schema };

for (const parent of [
  { type: "object" },
  { type: "object", additionalProperties: true },
  { type: "object", additionalProperties: true, properties: { plugins: { type: "object", additionalProperties: true } } },
]) {
  test(`composed slot writes remain readable and rogue children fail every write path (${JSON.stringify(parent)})`, async () => {
    const { configService: service, registry, writes, data, activate } = await fixture();
    assert.equal((await registry.register(registration(parent, slots))).success, true);
    assert.equal((await registry.register(fragment)).success, true);
    await activate();
    const options = { schemaRegistry: registry };
    assert.equal((await service.setRegisteredObject("platform", "/svc/plugins/analytics", {}, options)).success, true);
    assert.equal(await service.get("svc.plugins.analytics.enabled"), false);
    assert.deepEqual((await service.resolveAll()).entries.svc, { plugins: { analytics: { enabled: false } } });
    assert.deepEqual(await service.getNamespace("svc.plugins"), { analytics: { enabled: false } });
    const before = structuredClone(data);
    const writesBefore = writes.length;
    const revision = service.revision;
    const attempts = [
      () => service.set("platform", "svc.plugins.rogue", {}),
      () => service.set("platform", "svc.plugins.rogue.enabled", true),
      () => service.set("platform", "svc", { plugins: { rogue: {} } }),
      () => service.setMany("platform", { "svc.plugins.rogue": {}, "elsewhere.safe": true }),
      () => service.setRegisteredObject("platform", "/svc", { plugins: { rogue: {} } }, options),
      () => service.setRegisteredObject("platform", "/svc/plugins/rogue", {}, options),
      () => service.patchRegisteredPath("platform", "/svc/plugins", { rogue: {} }, options),
      () => service.patchRegisteredPath("platform", "/svc/plugins/rogue/enabled", true, options),
    ];
    for (const attempt of attempts) {
      const result = await attempt();
      assert.equal(result.success, false);
      assert.equal(result.error.code, "VALIDATION_ERROR");
    }
    assert.equal(writes.length, writesBefore);
    assert.equal(service.revision, revision);
    assert.deepEqual(data, before);
    assert.equal((await service.setMany("platform", { "svc.plugins.analytics.enabled": true })).success, true);
    assert.equal(await service.get("svc.plugins.analytics.enabled"), true);
    assert.equal((await service.remove("platform", "svc.plugins.analytics")).success, true);
    assert.deepEqual(await service.get("svc.plugins"), {});
  });
}

test("contradictory, overlapping and undeclared slots reject registration with zero effects", async () => {
  const { registry, writes } = await fixture(undefined, "fs-restart");
  for (const plugins of [{ type: "string" }, { type: "array", items: { type: "object" } }, { type: ["object", "null"] }]) {
    const result = await registry.register(registration({ type: "object", properties: { plugins } }, slots));
    assert.equal(result.success, false);
    assert.match(result.error.message, /structurally fit/);
  }
  assert.equal((await registry.register(registration({ type: "object" }, [...slots, { slotPath: "/plugins/deeper", accepts: "object" }]))).success, false);
  assert.equal((await registry.register(fragment)).success, false);
  assert.deepEqual(registry.listAll(), {});
  assert.deepEqual(writes, []);
});

test("nested slots/defaults and migration candidates use the same closed composition", () => {
  const nestedSlots = [{ slotPath: "/features/plugins", accepts: "object" }];
  const nested = { ...fragment, slotPath: "/features/plugins", schema: { ...schema, default: {} } };
  const request = registration({ type: "object", properties: { features: { type: "object", default: {}, properties: { plugins: { type: "object", default: {} } } } } }, nestedSlots);
  const composed = composeRegisteredServiceSchema(request, [nested]);
  const value = materializeConfigurationDefaults(composed, {});
  assert.deepEqual(value, { features: { plugins: { analytics: { enabled: false } } } });
  assert.equal(validateEffectiveConfiguration(composed, value).valid, true);
  assert.equal(validatePartialConfiguration(composed, { features: { plugins: { rogue: {} } } }).valid, false);
  const rogueDefault = registration({ type: "object", properties: { plugins: { type: "object", default: { rogue: {} }, additionalProperties: true } } }, slots);
  assert.throws(() => composeRegisteredServiceSchema(rogueDefault, [fragment]), /invalid defaults/);
});

test("persistent restart preserves composition and refuses orphan/contradictory registry data", async () => {
  const { registry, configService, providers, storage, writes, activate } = await fixture(undefined, "fs-restart");
  await registry.register(registration({ type: "object" }, slots));
  await registry.register(fragment);
  const raw = (await storage.load()).entries._weaver.catalog;
  assert.equal(projectCanonicalRegistrations(raw).state.schemas.size, 2);
  await activate();
  const writesBefore = writes.length;
  await configService.close();
  const restarted = await createWeaverConfigService({ providers, environment: "dev", controlLayer: "control" });
  const hydrated = createSchemaRegistry({ configService: restarted });
  assert.equal(writes.length, writesBefore);
  assert.equal((await restarted.setRegisteredObject("platform", "/svc/plugins/analytics", {}, { schemaRegistry: hydrated })).success, true);
  assert.equal(await restarted.get("svc.plugins.analytics.enabled"), false);
  const orphan = structuredClone(raw);
  Object.values(orphan.registrations).find((entry) => entry.kind === "service").request.fragmentSlots = [];
  assert.throws(() => projectCanonicalRegistrations(orphan));
  const contradictory = structuredClone(raw);
  Object.values(contradictory.registrations).find((entry) => entry.kind === "service").request.schema = { type: "object", properties: { plugins: { type: "number" } } };
  assert.throws(() => projectCanonicalRegistrations(contradictory));
  await restarted.close();
});

test("rogue provider data fails reads and cold scoped resolution despite permissive parent", async () => {
  const scoped = createInMemoryStorageProvider({ id: "tenant", layer: "tenant" });
  await scoped.writeLayer("tenant:good", "svc", { plugins: { analytics: {} } });
  await scoped.writeLayer("tenant:bad", "svc", { plugins: { rogue: {} } });
  const { configService, registry, writes, activate } = await fixture(undefined, "memory", [scoped], ["good", "bad"].map((value) => [{ scopeId: "tenant", value }]));
  await registry.register(registration({ type: "object", additionalProperties: true }, slots));
  await registry.register(fragment);
  await assert.rejects(activate());
  await assert.rejects(configService.get("svc"));
  await assert.rejects(configService.resolveAll());
  assert.deepEqual(writes, []);
});
