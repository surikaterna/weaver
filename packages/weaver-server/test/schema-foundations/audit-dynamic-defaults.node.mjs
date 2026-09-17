import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, owner, registration } from "./fixtures.mjs";
import { projectCanonicalRegistrations } from "../../src/core/canonical-projection.ts";

const patterns = (value) => ({ type: "object", patternProperties: {
  "^x$": { type: "object", properties: { p: { type: "integer", default: value } } },
  x: { type: "object", properties: { p: { type: "integer", maximum: 10 } } },
} });
const wrappers = [
  (schema) => schema,
  (schema) => ({ type: "object", properties: { unused: schema } }),
  (schema) => ({ type: "object", properties: { unused: { type: "array", items: schema } } }),
  (schema) => ({ type: "object", patternProperties: { "^unused$": schema } }),
];
const slots = [{ slotPath: "/plugins", accepts: "object" }];
const fragment = (schema) => ({ serviceId: "svc", environment: "dev", owner, providerId: "analytics", slotPath: "/plugins", schema });

test("R2b original first-registration repro rejects without its first persistence write", async () => {
  const { registry, writes } = await fixture({ svc: { x: {} } }, "fs-restart");
  assert.equal((await registry.register(registration(patterns(80)))).success, false);
  assert.deepEqual(writes, []);
  assert.deepEqual(registry.listAll(), {});
});

for (const profile of ["memory", "fs-restart"]) {
  test(`R2b rejects incompatible default-bearing dynamic pattern combinations before effects (${profile})`, async (context) => {
    const { configService, registry, writes, activate } = await fixture({ svc: { x: {} } }, profile);
    await registry.register(registration({ type: "object", additionalProperties: true }, slots));
    await activate();
    const before = structuredClone(registry.listAll());
    const writesBefore = writes.length;
    const revision = configService.revision;
    const events = [];
    context.after(configService.onDelta((event) => events.push(event)));
    for (const wrap of wrappers) {
      const schema = wrap(patterns(80));
      for (const request of [registration(schema, slots), fragment(schema)]) {
        const result = await registry.register(request);
        assert.equal(result.success, false);
        assert.equal(result.error.code, "VALIDATION_ERROR");
        assert.match(result.error.message, /default/i);
      }
    }
    assert.deepEqual(registry.listAll(), before);
    assert.equal(writes.length, writesBefore);
    assert.equal(configService.revision, revision);
    assert.deepEqual(events, []);
  });
}

test("R2b persisted service and fragment schemas reject unused overlapping dynamic defaults", async () => {
  const { registry, storage } = await fixture(undefined, "fs-restart");
  await registry.register(registration({ type: "object" }, slots));
  await registry.register(fragment({ type: "object" }));
  for (const wrap of wrappers) {
    for (const path of ["/svc", "/svc/plugins/analytics"]) {
      const raw = structuredClone((await storage.load()).entries._weaver.catalog);
      const item = Object.values(raw.registrations).find((record) => record.kind === (path === "/svc" ? "service" : "fragment"));
      item.request.schema = wrap(patterns(80));
      assert.throws(() => projectCanonicalRegistrations(raw), /default|canonical/i);
    }
  }
});

test("R2b compatible overlapping defaults and default-free patterns remain supported", async () => {
  const { registry, configService, activate } = await fixture({ svc: { x: {} } });
  assert.equal((await registry.register(registration(patterns(5)))).success, true);
  await activate();
  assert.deepEqual((await configService.resolveAll()).entries, { svc: { x: { p: 5 } } });
  const defaultFree = { type: "object", properties: { optional: { type: "object", patternProperties: {
    "^a$": { type: "string" }, "^b$": { type: "integer" },
  } } } };
  await configService.set("platform", "svc", {});
  assert.equal((await registry.register(registration(defaultFree), { expectedRevision: configService.revision })).success, true);
});

test("R2b conservatively denies unprovable dynamic default compatibility without a regex intersection solver", async () => {
  const { registry } = await fixture();
  const schema = { type: "object", patternProperties: {
    "^a$": { type: "object", properties: { p: { type: "integer", default: 80 } } },
    "^b$": { type: "object", properties: { p: { type: "integer", maximum: 10 } } },
  } };
  assert.equal((await registry.register(registration(schema))).success, false);
});
