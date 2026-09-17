import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceSchemaRegistrationRequestSchema, configurationPropertySchemaSchema } from "@weaver-conf/config-types";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { fixture, validateCanonicalSchema } from "./fixtures.mjs";

const owner = { name: "svc", contact: "svc@example.com" };
const request = (schema) => ({ serviceId: "svc", environment: "dev", owner, schema, fragmentSlots: [] });
const locations = [
  (s) => s,
  (s) => ({ type: "object", properties: { optional: s } }),
  (s) => ({ type: "object", patternProperties: { "^optional$": s } }),
  (s) => ({ type: "object", additionalProperties: s }),
  (s) => ({ type: "object", properties: { list: { type: "array", items: s } } }),
  (s) => ({ type: "object", properties: { list: { type: "array", items: [s] } } }),
];

for (const profile of ["memory", "fs-restart"]) {
  test(`unsupported grammar is rejected recursively before effects (${profile})`, async () => {
    const { registry, configService, writes } = await fixture({}, profile);
    const service = { ...request({ type: "object" }), fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }] };
    assert.equal((await registry.register(service)).success, true);
    const before = structuredClone(registry.listAll());
    const writesBefore = writes.length;
    for (const keyword of ["oneOf", "anyOf", "allOf", "not"]) {
      for (const wrap of locations) {
        const schema = wrap({ type: "object", [keyword]: keyword === "not" ? { type: "object" } : [{ type: "object" }] });
        assert.equal(configurationPropertySchemaSchema.safeParse(schema).success, true);
        assert.equal(serviceSchemaRegistrationRequestSchema.safeParse(request(schema)).success, false);
        for (const candidate of [request(schema), { serviceId: "svc", environment: "dev", owner, providerId: "plugin", slotPath: "/plugins", schema }]) {
          const result = await registry.register(candidate);
          assert.equal(result.success, false);
          assert.equal(result.error.code, "VALIDATION_ERROR");
          assert.match(result.error.message, new RegExp(keyword));
        }
        assert.throws(() => validateCanonicalSchema(schema), { code: "VALIDATION_ERROR" });
      }
    }
    assert.deepEqual(registry.listAll(), before);
    assert.equal(writes.length, writesBefore);
    await configService.close();
  });
}
