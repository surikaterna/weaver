import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateEffectiveCandidate } from "../../src/core/schema-effective-candidate.ts";
import { bindSchemaReadRegistry } from "../../src/core/schema-read-boundary.ts";
import { createRestAdapter } from "../../src/transport/rest-adapter.ts";
import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
import { createSSEAdapter } from "../../src/transport/sse-adapter.ts";
import { fixture, owner, registration } from "./fixtures.mjs";
import { projectCanonicalRegistrations } from "../../src/core/canonical-projection.ts";

const slots = [{ slotPath: "/plugins", accepts: "object" }];
const fragment = (schema) => ({ serviceId: "svc", environment: "dev", owner, providerId: "analytics", slotPath: "/plugins", schema });
const fields = (kind) => ({ _weaver: { type: "string", default: kind }, provider: { type: "string", default: "vault" }, uri: { type: "string", default: "hidden-reference" }, source: { type: "string", default: "hidden-source" } });
const root = (child) => ({ type: "object", properties: { child } });

test("R4b original first-registration repro rejects synthesized secret-ref before persistence", async () => {
  const { registry, writes } = await fixture({ svc: {} }, "fs-restart");
  const schema = root({ type: "object", default: {}, properties: {
    _weaver: { type: "string", default: "secret-ref" }, provider: { type: "string", default: "vault" }, uri: { type: "string", default: "hidden-reference" },
  } });
  assert.equal((await registry.register(registration(schema))).success, false);
  assert.deepEqual(writes, []);
  assert.deepEqual(registry.listAll(), {});
});

function schemas(kind) {
  const optional = { type: "object", properties: fields(kind) };
  return [
    root({ ...optional, default: {} }),
    root({ ...optional, default: { provider: "vault" } }),
    root(optional),
    root({ type: "array", items: optional }),
    root({ type: "array", default: [{}], items: optional }),
    root({ type: "array", default: [{}], items: [optional] }),
    { type: "object", patternProperties: { "^child$": optional } },
    { type: "object", properties: { child: { type: "object", default: {}, properties: { provider: { type: "string", default: "vault" } } } }, patternProperties: { child: optional } },
    root({ type: "object", patternProperties: { "^_weaver$": { type: "string", default: kind } } }),
    root({ type: "object", additionalProperties: { type: "string", default: kind } }),
  ];
}

for (const profile of ["memory", "fs-restart"]) {
  test(`R4b denies scalar/default-composed marker samples in services and fragments (${profile})`, async (context) => {
    const { registry, configService, writes, activate } = await fixture(undefined, profile);
    await registry.register(registration({ type: "object" }, slots));
    await activate();
    const before = structuredClone(registry.listAll());
    const revision = configService.revision;
    const writesBefore = writes.length;
    const events = [];
    context.after(configService.onDelta((event) => events.push(event)));
    for (const kind of ["secret-ref", "mount"]) {
      for (const schema of schemas(kind)) {
        for (const request of [registration(schema, slots), fragment(schema)]) {
          const result = await registry.register(request);
          assert.equal(result.success, false);
          assert.equal(result.error.code, "VALIDATION_ERROR");
          assert.match(result.error.message, /Materialized defaults.*markers/);
          assert.equal(result.error.message.includes("hidden-reference"), false);
        }
      }
    }
    assert.deepEqual(registry.listAll(), before);
    assert.equal(writes.length, writesBefore);
    assert.equal(configService.revision, revision);
    assert.deepEqual(events, []);
  });
}

test("R4b hydration rejects synthesized and incomplete-default marker schemas before binding", async () => {
  const { registry, storage } = await fixture(undefined, "fs-restart");
  await registry.register(registration({ type: "object" }, slots));
  await registry.register(fragment({ type: "object" }));
  for (const kind of ["secret-ref", "mount"]) {
    for (const schema of schemas(kind)) {
      for (const path of ["/svc", "/svc/plugins/analytics"]) {
        const raw = structuredClone((await storage.load()).entries._weaver.catalog);
        const item = Object.values(raw.registrations).find((record) => record.kind === (path === "/svc" ? "service" : "fragment"));
        item.request.schema = schema;
        assert.throws(() => projectCanonicalRegistrations(raw), (error) => error.code === "VALIDATION_ERROR" && /markers/.test(error.details?.error?.message ?? error.message));
      }
    }
  }
});

test("R4b final candidate safeguard refuses markers assembled by multiple governing schemas", () => {
  for (const kind of ["secret-ref", "mount"]) {
    const definitions = [
      root({ type: "object", default: {}, patternProperties: { "^_weaver$": { type: "string", default: kind } }, additionalProperties: true }),
      root({ type: "object", properties: { _weaver: { type: "string" }, source: { type: "string", default: "hidden-source" } }, additionalProperties: true }),
    ];
    const anchors = definitions.map((schema) => ({ kind: "service", path: "/svc", environment: "dev", schema, metadata: { serviceId: "svc", servicePath: "/svc", providerId: "svc", environment: "dev", owner } }));
    for (const ordering of [anchors, [...anchors].reverse()]) {
      const result = evaluateEffectiveCandidate(ordering, { svc: {} });
      assert.equal(result.valid, false);
      assert.match(result.errors[0].message, /must not contain.*markers/);
    }
    assert.equal(evaluateEffectiveCandidate([], { raw: [{ _weaver: kind }] }).valid, false);
  }
});

test("R4b canonical runtime binding cannot be replaced by an unvalidated schema", async (context) => {
  const { registry, configService, writes, activate } = await fixture();
  assert.equal((await registry.register(registration({ type: "object", additionalProperties: true }))).success, true);
  await activate();
  const events = [];
  context.after(configService.onDelta((event) => events.push(event)));
  const schema = root({ type: "object", default: {}, properties: fields("secret-ref") });
  assert.throws(() => bindSchemaReadRegistry(configService, () => [{ kind: "service", path: "/svc", environment: "dev", schema, metadata: { serviceId: "svc", servicePath: "/svc", providerId: "svc", environment: "dev", owner } }]), { code: "FORBIDDEN" });
  assert.equal((await registry.register(registration(schema), { expectedRevision: configService.revision })).success, false);
  assert.deepEqual((await configService.resolveAll()).entries, { svc: {} });
  assert.equal(await configService.get("svc.child"), undefined);
  await assert.rejects(configService.resolveAll({ scopePath: [{ scopeId: "tenant", value: "one" }] }), { code: "SCOPE_NOT_FOUND" });
  assert.equal((await configService.validateRegisteredEffective("/svc", { schemaRegistry: registry })).valid, true);
  const rest = createRestAdapter({ configService });
  const response = await rest.handleRequest("GET", "/v1/config", { params: {}, query: {}, headers: {} });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(response.body).includes("hidden-source"), false);
  const scomp = createWeaverScompService({ configService, schemaRegistry: registry, scopeManager: {} });
  assert.deepEqual((await scomp.router["weaver-config-v1.resolveAll"].handler({})).entries, { svc: {} });
  const sse = createSSEAdapter({ configService });
  const client = await sse.createClient();
  assert.equal(client.messages.join("").includes("hidden-source"), false);
  sse.removeClient(client);
  assert.equal(sse.clientCount, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(events, []);
  await configService.close();
});

test("R4b ordinary synthesized _weaver values remain ordinary configuration", async () => {
  const { registry, configService, activate } = await fixture();
  let active = false;
  for (const value of ["ordinary", { tag: "ordinary" }]) {
    const schema = root({ type: "object", default: {}, properties: { _weaver: { type: typeof value === "string" ? "string" : "object", additionalProperties: true, default: value } } });
    assert.equal((await registry.register(registration(schema), { expectedRevision: configService.revision })).success, true);
    if (!active) { await activate(); active = true; }
    assert.deepEqual(await configService.get("svc.child"), { _weaver: value });
  }
});
