import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { evaluateEffectiveCandidate } from "../../src/core/schema-effective-candidate.ts";
import { fixture, owner, registration, validateCanonicalSchema } from "./fixtures.mjs";

const overlap = (value) => ({ type: "object", properties: { x: { type: "integer", default: value } }, patternProperties: { "^x$": { type: "integer", maximum: 10 } } });
const numbered = (value) => ({ type: "object", required: ["x"], properties: { x: { type: "integer", default: value, enum: [value, 3] } } });

test("R3 scoped fallback uses the one committed catalog, not a stale registry handle", async () => {
  const scoped = createInMemoryStorageProvider({ id: "scope", layer: "tenant:one", initialEntries: { svc: { x: 3 } } });
  const scopePath = [{ scopeId: "tenant", value: "one" }];
  const { registry, configService, activate } = await fixture(undefined, "memory", [scoped], [scopePath]);
  try {
    assert.equal((await registry.register(registration(numbered(1)))).success, true);
    await activate();
    const second = createSchemaRegistry({ configService });
    assert.equal((await second.register(registration(numbered(2)))).error.code, "REVISION_CONFLICT");
    assert.equal(await configService.get("svc.x", { scopePath }), 3);
    assert.equal((await configService.remove("tenant:one", "svc.x", { scopePath })).success, true);
    assert.equal(await configService.get("svc.x", { scopePath }), 1);
  } finally { await configService.close(); }
});

for (const profile of ["memory", "fs-restart"]) test(`R2 defaults satisfy every applicable constraint, including absent branches (${profile})`, async () => {
  const { registry, configService, writes, activate } = await fixture(undefined, profile);
  try {
    const candidates = [overlap(80),
      { type: "object", properties: { unused: overlap(80) } },
      { type: "object", properties: { unused: { type: "array", items: overlap(80) } } },
      { type: "object", properties: { unused: { type: "object", properties: { x: { type: "integer", default: 80 } } } }, patternProperties: { "^unused$": { type: "object", properties: { x: { type: "integer", maximum: 10 } } } } },
    ];
    for (const schema of candidates) {
      const result = await registry.register(registration(schema));
      assert.equal(result.success, false);
      assert.match(result.error.message, /default/i);
      assert.throws(() => validateCanonicalSchema(schema), /default/i);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(registry.listAll(), {});
    assert.equal((await registry.register(registration(overlap(5)))).success, true);
    await activate();
    assert.equal(await configService.get("svc.x"), 5);
  } finally { await configService.close(); }
});

for (const explicitParent of [false, true]) test(`R3 fragment effective check uses its actual parent context (${explicitParent})`, async () => {
  const { registry, configService, writes, activate } = await fixture();
  try {
    const parent = { type: "object", ...(explicitParent ? { properties: { plugins: { type: "object", default: {} } } } : {}) };
    await registry.register(registration(parent, [{ slotPath: "/plugins", accepts: "object" }]));
    await registry.register({ serviceId: "svc", environment: "dev", owner, providerId: "analytics", slotPath: "/plugins", schema: { type: "object", default: {}, required: ["port"], properties: { port: { type: "integer", default: 80 } } } });
    await activate();
    assert.deepEqual(await configService.get("svc.plugins.analytics"), explicitParent ? { port: 80 } : undefined);
    const result = await configService.validateRegisteredEffective("/svc/plugins/analytics", { schemaRegistry: registry });
    assert.equal(result.valid, explicitParent);
    assert.deepEqual((await configService.resolveAll()).entries, explicitParent ? { svc: { plugins: { analytics: { port: 80 } } } } : { svc: {} });
    assert.deepEqual(writes, []);
  } finally { await configService.close(); }
});

for (const reversed of [false, true]) {
  test(`R3 complementary governing defaults share one traversal (${reversed})`, () => {
    const child = { type: "object", properties: { group: { type: "object", required: ["x"], properties: { x: { type: "integer", default: 1 } } } } };
    const parent = { type: "object", properties: { group: { type: "object", default: {}, properties: { x: { type: "integer" } } } } };
    const schemas = reversed ? [parent, child] : [child, parent];
    const anchors = schemas.map((schema) => ({ kind: "service", path: "/svc", environment: "dev", schema, metadata: { serviceId: "svc", servicePath: "/svc", providerId: "svc", environment: "dev", owner } }));
    const candidate = evaluateEffectiveCandidate(anchors, { svc: {} });
    assert.equal(candidate.valid, true);
    assert.deepEqual(candidate.entries, { svc: { group: { x: 1 } } });
  });

  test(`R3 stale registries cannot install competing fallback defaults (${reversed})`, async () => {
    const { registry, configService, data, activate } = await fixture({ svc: { x: 3 } });
    try {
      const [first, second] = reversed ? [2, 1] : [1, 2];
      await registry.register(registration(numbered(first)));
      await activate();
      const other = createSchemaRegistry({ configService });
      const revision = configService.revision;
      assert.equal((await other.register(registration(numbered(second)))).error.code, "REVISION_CONFLICT");
      assert.equal(configService.revision, revision);
      assert.deepEqual(data, { svc: { x: 3 } });
      assert.equal((await configService.remove("platform", "svc.x")).success, true);
      assert.equal(await configService.get("svc.x"), first);
      assert.equal((await other.register(registration(numbered(second)), { expectedRevision: revision })).error.code, "REVISION_CONFLICT");
    } finally { await configService.close(); }
  });
}
