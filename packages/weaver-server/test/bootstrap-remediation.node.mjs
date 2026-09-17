import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createStandaloneFixture, testJwt } from "./standalone-fixture.ts";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { createBuiltinProviderFactories } from "../src/bootstrap/provider-resources.ts";
import { inspectWeaver } from "../src/bootstrap/runtime-open.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { startWeaverServer } from "../src/server.ts";

const owner = { name: "team", contact: "team@example.test" };
function jwt(roles, secret = testJwt) {
  const content = [ { alg: "HS256", typ: "JWT" }, { userId: "operator", roles, exp: Math.floor(Date.now() / 1000) + 60 } ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
}
test("qfid restores real OPTIONS 204/CORS without bypassing mutation authentication or roles", { timeout: 30_000 }, async () => {
  const origin = "https://allowed.example";
  const fixture = await createStandaloneFixture({ corsOrigins: [origin], adminRoles: ["operators"], schemas: { svc: { type: "object", default: {}, properties: { value: { type: "integer", default: 1 } } } } });
  let server;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    const base = `http://127.0.0.1:${server.port}`;
    const before = await readFile(fixture.seed.store.locator.filePath, "utf8");
    const revision = server.runtime.configService.revision;
    for (const [method, path, body] of [
      ["PUT", "/v1/config/svc/value?layer=platform", { value: 9 }],
      ["POST", "/v1/admin/schemas/services", { serviceId: "other", environment: "dev", owner, schema: { type: "object" }, fragmentSlots: [] }],
      ["PATCH", "/v1/config?layer=platform", { entries: { "svc.value": 9 } }],
      ["DELETE", "/v1/config/svc/value?layer=platform", undefined],
    ]) {
      for (const allowed of [true, false]) {
        const response = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { origin: allowed ? origin : "https://denied.example", "access-control-request-method": method, "access-control-request-headers": "Authorization, Content-Type" }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 204);
        assert.equal(await response.text(), "");
        assert.equal(response.headers.get("access-control-allow-origin"), allowed ? origin : null);
        if (allowed) {
          assert.ok(response.headers.get("access-control-allow-methods").includes(method));
          assert.equal(response.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
        }
      }
      for (const [token, status] of [[undefined, 401], [jwt(["operators"], "bad"), 401], [jwt(["reader"]), 403]]) {
        const response = await fetch(`${base}${path}`, { method, headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, status, `${method} ${token ? status : "no JWT"}`);
      }
    }
    assert.equal(server.runtime.configService.revision, revision);
    assert.equal(await readFile(fixture.seed.store.locator.filePath, "utf8"), before);
    assert.equal(await server.runtime.configService.get("svc.value"), 1);
    const response = await fetch(`${base}/v1/config/svc/value?layer=platform`, { method: "PUT", headers: { origin, "content-type": "application/json", authorization: `Bearer ${jwt(["operators"])}` }, body: JSON.stringify({ value: 9 }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(await server.runtime.configService.get("svc.value"), 9);
  } finally { await server?.close(); await fixture.dispose(); }
});

function registrations() {
  return ["alpha", "beta"].flatMap((serviceId) => {
    const service = { serviceId, environment: "dev", owner, schema: { type: "object", default: {} }, fragmentSlots: [{ slotPath: "/features/plugins", accepts: "object" }] };
    const children = ["one", "two"].map((providerId) => ({ serviceId, providerId, slotPath: "/features/plugins", environment: "dev", owner, schema: { type: "object", properties: { value: { type: "integer", default: 7 } } } }));
    return [service, ...children];
  });
}
function failCatalogProgress(limit) {
  const factories = new Map(createBuiltinProviderFactories());
  const installed = factories.get("fs");
  factories.set("fs", { ...installed, async create(definition, context) {
    const resource = await installed.create(definition, context);
    if (definition.id === "control") {
      const authority = resource.provider.authority;
      const commit = authority.commitLayer.bind(authority);
      authority.commitLayer = async (request, handle) => {
        const registration = request.mutation.key.startsWith("_weaver.catalog.registrations.");
        if (registration) {
          const current = await authority.readLayer(request.layer);
          const count = Object.keys(current.entries._weaver?.catalog?.registrations ?? {}).length;
          if (count >= limit) return { success: false, error: { code: "WRITE_ERROR", message: "injected registration progress failure" } };
        }
        return commit(request, handle);
      };
    }
    return resource;
  } });
  return factories;
}
for (const reverse of [false, true]) test(`xfke unordered multiple-service/nested-slot bootstrap initializes and restarts (reverse=${reverse})`, { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture();
  const input = { ...fixture.request, registrations: reverse ? registrations().reverse() : registrations() };
  let runtime;
  try {
    await initializeWeaver(fixture.seed, input, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal(Object.keys(runtime.schemaRegistry.listAll()).length, 6);
    assert.equal((await runtime.configService.set("platform", "alpha.features.plugins.one", {})).success, true);
    assert.equal(await runtime.configService.get("alpha.features.plugins.one.value"), 7);
    const catalog = runtime.schemaRegistry.listAll();
    await runtime.close();
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.deepEqual(runtime.schemaRegistry.listAll(), catalog);
    assert.equal(await runtime.configService.get("alpha.features.plugins.one.value"), 7);
  } finally { await runtime?.close(); await fixture.dispose(); }
});

for (const progress of [1, 3]) test(`xfke normalized exact intent resumes after ${progress} records, never adopts changed requests`, { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture();
  const input = { ...fixture.request, registrations: registrations().reverse() };
  let runtime;
  try {
    await assert.rejects(initializeWeaver(fixture.seed, input, fixture.administrator, { credentials: fixture.credentials, factories: failCatalogProgress(progress) }));
    const before = await readFile(fixture.seed.store.locator.filePath, "utf8");
    const records = JSON.parse(before).entries._weaver.catalog.registrations;
    assert.equal(Object.keys(records).length, progress);
    assert.equal((await inspectWeaver(fixture.seed, { credentials: fixture.credentials })).state, "maintenance");
    const changed = structuredClone(input);
    changed.registrations[0].owner.name = "different";
    await assert.rejects(initializeWeaver(fixture.seed, changed, fixture.administrator, { credentials: fixture.credentials }), { code: "CONFIG_NOT_READY" });
    assert.equal(await readFile(fixture.seed.store.locator.filePath, "utf8"), before);
    await assert.rejects(initializeWeaver(fixture.seed, { ...input, registrations: [...input.registrations].reverse() }, fixture.administrator, { credentials: fixture.credentials }), { code: "CONFIG_NOT_READY" });
    assert.equal(await readFile(fixture.seed.store.locator.filePath, "utf8"), before);
    await initializeWeaver(fixture.seed, input, fixture.administrator, { credentials: fixture.credentials });
    const after = JSON.parse(await readFile(fixture.seed.store.locator.filePath, "utf8")).entries._weaver;
    for (const [id, record] of Object.entries(records)) assert.deepEqual(after.catalog.registrations[id], record);
    assert.equal(after.format.initializationIntent.inputDigest, JSON.parse(before).entries._weaver.format.initializationIntent.inputDigest);
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal(Object.keys(runtime.schemaRegistry.listAll()).length, 6);
    const fragment = registrations().find((request) => "providerId" in request);
    assert.equal((await runtime.schemaRegistry.register(fragment)).success, false);
  } finally { await runtime?.close(); await fixture.dispose(); }
});

test("xfke non-executable registration prefixes refuse before any durable intent", async () => {
  const fixture = await createStandaloneFixture();
  try {
    const input = { ...fixture.request, registrations: registrations() };
    input.registrations[0].fragmentSlots = [];
    await assert.rejects(initializeWeaver(fixture.seed, input, fixture.administrator, { credentials: fixture.credentials }), { code: "VALIDATION_ERROR" });
    assert.deepEqual(await readdir(fixture.directory), []);
  } finally { await fixture.dispose(); }
});
