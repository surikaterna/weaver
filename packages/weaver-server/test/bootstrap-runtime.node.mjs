import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createHmac } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createStandaloneFixture, testAdmin, testJwt } from "./standalone-fixture.ts";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { authenticateBootstrapAdministrator } from "../src/bootstrap/seed-trust.ts";
import { createBuiltinProviderFactories } from "../src/bootstrap/provider-resources.ts";
import { inspectWeaver } from "../src/bootstrap/runtime-open.ts";
import { startWeaverServer } from "../src/server.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";

function token(roles = ["admin"], secret = testJwt) {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ userId: "operator", roles, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const content = `${head}.${body}`;
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
}
async function request(server, path, method = "GET", body, auth = token(), revision) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(revision ? { "if-match": revision } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
}
const schema = { type: "object", default: {}, properties: { value: { type: "integer", default: 1 } }, additionalProperties: false };

test("mic8 public surfaces expose current seed/catalog APIs, not obsolete bootstrap or registry codecs", async () => {
  const server = await import("../src/index.ts");
  const types = await import("@weaver-conf/config-types");
  for (const name of ["bootstrap", "createProviders", "registerProviderFactory", "resolveEnvVars", "createPersistentSchemaRegistry", "withEnvironmentOverlay", "parseServerEnv", "bootstrapConfigSchema", "bootstrapLayerSchema"]) assert.equal(Object.hasOwn(server, name), false, name);
  for (const name of ["bootstrapConfigSchema", "bootstrapLayerSchema", "layerProviderSchema", "builtinProviders"]) assert.equal(Object.hasOwn(types, name), false, name);
  for (const name of ["initializeWeaver", "startWeaverServer", "openWeaverRuntime", "createSchemaRegistry", "createScopeManager"]) assert.equal(typeof server[name], "function", name);
  assert.equal(types.bootstrapSeedSchema.safeParse({ version: 99 }).success, false);
});

test("qkmd/2q6b real FS initialize -> HTTP scope lifecycle -> conditional schema -> write/read -> restart", { timeout: 30_000 }, async () => {
  const scopePath = [{ scopeId: "tenant", value: "acme" }];
  const fixture = await createStandaloneFixture({ retired: [scopePath] });
  let server;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    assert.equal(server.isReady, true);
    assert.equal((await request(server, "/readyz")).status, 200);
    assert.equal((await request(server, "/v1/config?scope=tenant:acme")).status, 404);
    assert.equal((await request(server, "/v1/admin/scopes/tenant", "POST", { value: "acme" }, undefined)).status, 201);
    const registration = { serviceId: "svc", environment: "dev", owner: { name: "team", contact: "team@example.test" }, schema, fragmentSlots: [] };
    assert.equal((await request(server, "/v1/admin/schemas/services", "POST", registration)).status, 201);
    const changed = { ...registration, schema: { ...schema, properties: { value: { type: "integer", default: 2 } } } };
    assert.equal((await request(server, "/v1/admin/schemas/services", "POST", changed, token(), "stale")).status, 409);
    assert.equal((await request(server, "/v1/admin/schemas/services", "POST", changed, token(), server.runtime.configService.revision)).status, 201);
    assert.equal((await request(server, "/v1/config/svc/value?layer=platform", "PUT", { value: 9 })).status, 200);
    assert.equal((await request(server, "/v1/config/svc/value?layer=tenant:acme", "PUT", { value: 12 })).status, 200);
    assert.equal((await (await request(server, "/v1/config/svc/value?scope=tenant:acme")).json()).data.value, 12);
    const peer = { identity: { userId: "operator", roles: ["admin"] }, isAdmin: true, isUser: true, isService: false };
    const scomp = server.runtime.createScompService(() => peer);
    assert.deepEqual(await scomp.router["weaver-config-v1.listScopeValues"].handler({ scopeId: "tenant" }), { values: ["acme"] });
    assert.equal((await scomp.router["weaver-config-v1.get"].handler({ key: "svc.value", scope: "tenant:acme" })).value, 12);
    const revision = server.runtime.configService.revision;
    await server.close();
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    assert.equal(server.runtime.configService.revision, revision);
    assert.equal((await (await request(server, "/v1/config/svc/value?scope=tenant:acme")).json()).data.value, 12);
    assert.equal((await request(server, "/v1/admin/scopes/tenant/acme", "DELETE")).status, 200);
    assert.equal((await request(server, "/v1/config?scope=tenant:acme")).status, 404);
  } finally { await server?.close(); await fixture.dispose(); }
});

test("qkmd standalone trust refuses admin strings, bad JWT/roles and unknown scopes without effects", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture({ retired: [[{ scopeId: "tenant", value: "known" }]], adminRoles: ["operators"] });
  let server;
  try {
    await assert.rejects(initializeWeaver(fixture.seed, fixture.request, { actor: "seed-administrator" }, { credentials: fixture.credentials }), { code: "FORBIDDEN" });
    assert.deepEqual(await readdir(fixture.directory), []);
    await assert.rejects(authenticateBootstrapAdministrator(fixture.seed, "admin", fixture.credentials), { code: "UNAUTHORIZED" });
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    const revision = server.runtime.configService.revision;
    assert.equal((await request(server, "/v1/admin/scopes/tenant", "POST", { value: "known" }, "")).status, 401);
    assert.equal((await request(server, "/v1/admin/scopes/tenant", "POST", { value: "known" }, token(["operators"], "wrong"))).status, 401);
    assert.equal((await request(server, "/v1/admin/scopes/tenant", "POST", { value: "known" }, token(["admin"]))).status, 403);
    assert.equal((await request(server, "/v1/admin/scopes/tenant", "POST", { value: "unallocated" }, token(["operators"]))).status, 409);
    assert.equal(server.runtime.configService.revision, revision);
    assert.deepEqual(server.runtime.scopeManager.listScopeValues("tenant"), []);
    const forged = server.runtime.createScompService(() => ({ identity: { userId: "viewer", roles: ["admin"] }, isAdmin: true, isUser: true, isService: false }));
    await assert.rejects(forged.router["weaver-config-v1.set"].handler({ layer: "platform", key: "x", value: 1 }), { code: "FORBIDDEN" });
  } finally { await server?.close(); await fixture.dispose(); }
});

test("qkmd declarative order is the only merge/rank authority; staged activation requires restart", { timeout: 30_000 }, async () => {
  const scopePath = [{ scopeId: "tenant", value: "one" }];
  const fixture = await createStandaloneFixture({ paths: [scopePath], schemas: { svc: schema } });
  const late = { id: "late", factory: "fs", options: { filePath: join(fixture.directory, "late", "entries.json") } };
  const input = structuredClone(fixture.request);
  input.generation.providers.push(late);
  input.generation.layout.layers.push({ name: "late", type: "static", providerId: "late", config: { mergeId: "deep" } });
  let runtime;
  let server;
  try {
    await initializeWeaver(fixture.seed, input, fixture.administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    runtime = server.runtime;
    assert.equal((await runtime.configService.set("platform", "svc.value", 3)).success, true);
    assert.equal((await runtime.configService.set("tenant:one", "svc.value", 4)).success, true);
    assert.equal((await runtime.configService.set("late", "svc.value", 5)).success, true);
    assert.equal(await runtime.configService.get("svc.value", { scopePath }), 5);
    assert.equal(runtime.configService.layout.getRank("late"), 3);
    const candidate = structuredClone(input.generation);
    const layer = candidate.layout.layers.pop();
    candidate.layout.layers.splice(2, 0, layer);
    const revision = runtime.configService.revision;
    await runtime.stageInfrastructure("g2", candidate, revision, fixture.administrator);
    assert.equal(runtime.status.activeGeneration, "g1");
    await runtime.activateInfrastructure(
      "g2",
      runtime.status.revision,
      fixture.administrator,
    );
    assert.equal(runtime.state, "restart_required");
    assert.equal((await request(server, "/v1/events")).status, 503);
    await assert.rejects(runtime.configService.resolveAll(), { code: "MAINTENANCE" });
    await server.close();
    server = undefined;
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal(await runtime.configService.get("svc.value", { scopePath }), 4);
    assert.equal(runtime.configService.layout.getRank("tenant"), 3);
  } finally { await server?.close(); await runtime?.close(); await fixture.dispose(); }
});

test("qkmd fresh initialization validates unknown factories/merges/credentials before writes", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture();
  try {
    for (const change of [
      (input) => { input.generation.providers[1].factory = "require-arbitrary-code"; },
      (input) => { input.generation.layout.layers[1].config.mergeId = "custom"; },
      (input) => { input.generation.layout.layers[1].type = "personal"; },
      (input) => { input.generation.layout.layers[1].providerId = "missing"; },
      (input) => { input.generation.server.auth.credentialRef = "missingCredential"; },
      (input) => { input.generation.layout.scopes = [{ id: "a", label: "a", parentScopeId: "b" }, { id: "b", label: "b", parentScopeId: "a" }]; },
      (input) => { input.generation.providers[0].options.filePath = join(fixture.directory, "relocated", "entries.json"); },
    ]) {
      const input = structuredClone(fixture.request); change(input);
      await assert.rejects(initializeWeaver(fixture.seed, input, fixture.administrator, { credentials: fixture.credentials }));
      assert.deepEqual(await readdir(fixture.directory), []);
    }
  } finally { await fixture.dispose(); }
});

test("qkmd a failed final activation leaves a seed-reachable recorded intent, never ordinary readiness", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture();
  const factories = new Map(createBuiltinProviderFactories());
  const installed = factories.get("fs");
  factories.set("fs", { ...installed, async create(definition, context) {
    const resource = await installed.create(definition, context);
    if (definition.id === "control") {
      const authority = resource.provider.authority;
      const commit = authority.commitLayer.bind(authority);
      authority.commitLayer = async (request, handle) => request.mutation.action === "set" && request.mutation.key === "_weaver" && request.mutation.value?.format?.initialization === "initialized" ? { success: false, error: { code: "WRITE_ERROR", message: "injected activation failure" } } : commit(request, handle);
    }
    return resource;
  } });
  try {
    await assert.rejects(initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials, factories }));
    const before = await readFile(fixture.seed.store.locator.filePath, "utf8");
    assert.equal((await inspectWeaver(fixture.seed, { credentials: fixture.credentials })).state, "maintenance");
    await assert.rejects(startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials }), { code: "MAINTENANCE" });
    const different = structuredClone(fixture.request);
    different.generation.server.port++;
    await assert.rejects(initializeWeaver(fixture.seed, different, fixture.administrator, { credentials: fixture.credentials }));
    assert.equal(await readFile(fixture.seed.store.locator.filePath, "utf8"), before);
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    const recovered = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    await recovered.close();
  } finally { await fixture.dispose(); }
});

test("qkmd HTTP/CORS errors remain typed and maintenance closes established SSE without changing the active generation", { timeout: 30_000 }, async () => {
  const origin = "https://bootstrap-client.example";
  const fixture = await createStandaloneFixture({ schemas: { svc: schema }, corsOrigins: [origin] });
  let server;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    const base = `http://127.0.0.1:${server.port}`;
    const cors = await fetch(`${base}/v1/config`, { headers: { origin }, signal: AbortSignal.timeout(30_000) });
    assert.equal(cors.status, 200);
    assert.equal(cors.headers.get("access-control-allow-origin"), origin);
    const malformed = await fetch(`${base}/v1/config/svc/value`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{", signal: AbortSignal.timeout(30_000) });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid request body" });
    assert.equal((await fetch(`${base}/unknown`, { signal: AbortSignal.timeout(30_000) })).status, 404);
    const stream = await fetch(`${base}/v1/events`, { signal: AbortSignal.timeout(5000) });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    assert.equal((await reader.read()).done, false);
    const revision = server.runtime.configService.revision;
    const invalid = structuredClone(fixture.request.generation);
    invalid.layout.layers[1].config.mergeId = "uninstalled";
    await assert.rejects(server.runtime.stageInfrastructure("bad", invalid, revision, fixture.administrator));
    assert.equal(server.runtime.status.activeGeneration, "g1");
    assert.throws(() => server.runtime.configService.revision, { code: "MAINTENANCE" });
    assert.equal((await reader.read()).done, true);
    assert.equal((await request(server, "/readyz")).status, 503);
    assert.equal((await request(server, "/v1/events")).status, 503);
    await assert.rejects(server.runtime.configService.get("svc.value"), { code: "MAINTENANCE" });
  } finally { await server?.close(); await fixture.dispose(); }
});

test("mic8 missing/old/future/plain stores refuse unchanged and current malformed/mixed metadata is nonready", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture();
  const path = fixture.seed.store.locator.filePath;
  try {
    await assert.rejects(startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials }));
    await mkdir(dirname(path), { recursive: true });
    for (const content of ['{"_weaver":{"schemas":{}}}', '{"_weaver":{"registry":{"schemas":{}}}}', '{"storageFormat":99,"entries":{}}', "not json"]) {
      await writeFile(path, content);
      await assert.rejects(startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials }));
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally { await fixture.dispose(); }
  const current = await createStandaloneFixture();
  try {
    await initializeWeaver(current.seed, current.request, current.administrator, { credentials: current.credentials });
    const path = current.seed.store.locator.filePath;
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const change of [
      (state) => { state.entries._weaver.format.version = 99; },
      (state) => { state.entries._weaver.format.builtinCatalog.digest = "0".repeat(64); },
      (state) => { state.entries._weaver.registry = { schemas: {} }; },
      (state) => { delete state.entries._weaver.format.initializationIntent; },
    ]) {
      const state = structuredClone(original); change(state);
      const content = JSON.stringify(state); await writeFile(path, content);
      await assert.rejects(startWeaverServer({ seed: current.seed, credentials: current.credentials }));
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally { await current.dispose(); }
});
