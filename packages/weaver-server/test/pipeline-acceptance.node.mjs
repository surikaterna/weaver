import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { internalRegistrationId } from "@weaver-conf/config-types";
import { createFileSystemStorageProvider, createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { controlTransaction } from "../src/core/config-service-internal.ts";
import { createControlService } from "../src/core/control-service.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { createScopeManager } from "../src/core/scope-manager.ts";
import { fixture } from "./schema-foundations/fixtures.mjs";
import { initializeOwned } from "./owned-fixtures.mjs";
import { configuration, initialized, record } from "./validated-fixtures.mjs";

const schema = {
  type: "object", required: ["n"], additionalProperties: false,
  properties: { n: { type: "number" }, mode: { type: "string", default: "safe" } },
};
const cold = [{ scopeId: "tenant", value: "cold" }];

for (const type of ["personal", "ephemeral"]) {
  test(`hywh: unsupported ${type} layers refuse rather than silently dropping provider data`, async (t) => {
    const providers = [
      createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: { svc: { n: 1 } } }),
      createInMemoryStorageProvider({ id: "app", layer: "app", initialEntries: { svc: { n: 2 } } }),
    ];
    const control = await createControlService({ providers, environment: "dev" });
    t.after(() => control.close());
    const state = configuration(control.binding, providers);
    state.infrastructure.generations.g1.layout.layers[1].type = type;
    const before = await Promise.all(providers.map((provider) => provider.load()));
    const revision = control.revision;
    const result = await control.initialize(state);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "UNSUPPORTED_AUTHORITY");
    assert.equal(control.revision, revision);
    assert.deepEqual(await Promise.all(providers.map((provider) => provider.load())), before);
    await assert.rejects(control.application());
  });
}

async function scopedFixture(t, state = "active") {
  const f = await initialized({ records: [record("svc", schema)], data: { svc: { n: 1 } },
    scopes: [{ id: "tenant", label: "Tenant" }], contexts: [{ scopePath: cold, state }],
    scoped: { "tenant:cold": { svc: { n: 2 } } } });
  t.after(() => f.service.close());
  return f;
}

test("hywh: a captured internal writer expires and unawaited IO cannot escape the coordinator", async (t) => {
  const f = await initialized();
  t.after(() => f.service.close());
  const registration = record("svc", schema);
  const key = `_weaver.catalog.registrations.${internalRegistrationId(registration)}`;
  let escaped;
  await controlTransaction(f.service, "catalog", async ({ write }) => { escaped = write; });
  await assert.rejects(escaped(key, registration), { code: "FORBIDDEN" });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const commit = f.platform.authority.commitLayer.bind(f.platform.authority);
  t.mock.method(f.platform.authority, "commitLayer", async (...args) => {
    entered.resolve();
    await release.promise;
    return commit(...args);
  });
  let result;
  const transaction = controlTransaction(f.service, "catalog", async ({ write }) => {
    result = write(key, registration);
  });
  await entered.promise;
  let completed = false;
  const next = f.service.set("platform", "svc.n", 1).then((value) => { completed = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release.resolve();
  await transaction;
  assert.equal((await result).success, true);
  assert.equal((await next).success, true);
});

test("4z58: a generic mutable provider never supplies an implicit permissive schema", async (t) => {
  const f = await fixture({ svc: { n: 1 } });
  t.after(() => f.configService.close());
  assert.equal((await f.control.finalize(f.control.revision)).success, false);
  await assert.rejects(f.configService.resolveAll(), { code: "CONFIG_NOT_READY" });
  assert.equal(
    (await f.control.registerSchema(record("svc", schema).request)).success,
    true,
  );
  await f.activate();
  const revision = f.configService.revision;
  for (const result of [
    await f.configService.set("platform", "svc", { n: "wrong" }),
    await f.configService.setMany("platform", { "svc.n": "wrong" }),
    await f.configService.remove("platform", "svc.n"),
    await f.configService.setRegisteredObject("platform", "/svc", { n: "wrong" }, { schemaRegistry: f.registry }),
    await f.configService.patchRegisteredPath("platform", "/svc/n", "wrong", { schemaRegistry: f.registry }),
  ]) assert.equal(result.success, false);
  assert.deepEqual(f.writes, []);
  assert.equal(f.configService.revision, revision);
  const events = [];
  f.configService.onDelta((delta) => events.push(delta));
  f.data.svc.n = "invalid-ingestion";
  await assert.rejects(f.configService.reloadProvider("p"));
  await assert.rejects(f.configService.get("svc.n"));
  assert.deepEqual(events, []);
  f.data.svc.n = 2;
  await f.configService.reloadProvider("p");
  assert.equal(await f.configService.get("svc.n"), 2);
});

test("29r: required, nested, enum and range activation failures preserve every context and revision", async (t) => {
  const baseSchema = { ...schema, properties: { ...schema.properties,
    nested: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] } } };
  const f = await initialized({ records: [record("svc", baseSchema)], data: { svc: { n: 1, nested: { enabled: true } } },
    scopes: [{ id: "tenant", label: "Tenant" }], contexts: [{ scopePath: cold, state: "active" }],
    scoped: { "tenant:cold": { svc: { n: 2 } } } });
  t.after(() => f.service.close());
  const registry = createSchemaRegistry({ configService: f.service });
  const before = await f.platform.load();
  const revision = f.service.revision;
  const events = [];
  f.service.onDelta((delta) => events.push(delta));
  const changes = [
    { ...baseSchema, required: ["n", "newRequired"], properties: { ...baseSchema.properties, newRequired: { type: "string" } } },
    { ...baseSchema, properties: { ...baseSchema.properties, nested: { type: "object", properties: { enabled: { type: "string" } } } } },
    { ...baseSchema, properties: { ...baseSchema.properties, n: { type: "number", enum: [1] } } },
    { ...baseSchema, properties: { ...baseSchema.properties, n: { type: "number", maximum: 1 } } },
  ];
  for (const candidate of changes) {
    const result = await registry.register({ ...record("svc", candidate).request, schemaVersion: "opaque-downgrade" }, { expectedRevision: revision });
    assert.equal(result.success, false);
    assert.equal(f.service.revision, revision);
    assert.deepEqual(await f.platform.load(), before);
    assert.equal(await f.service.get("svc.n", { scopePath: cold }), 2);
  }
  assert.deepEqual(events, []);
});

test("29r/9qje: mutation winning a deterministic barrier invalidates queued schema preflight", async (t) => {
  const f = await scopedFixture(t);
  const registry = createSchemaRegistry({ configService: f.service });
  const revision = f.service.revision;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const commit = f.platform.authority.commitLayer.bind(f.platform.authority);
  t.mock.method(f.platform.authority, "commitLayer", async (...args) => {
    entered.resolve(); await release.promise; return commit(...args);
  });
  const mutation = f.service.set("platform", "svc.n", 3);
  await entered.promise;
  const replacement = registry.register(record("svc", { ...schema, properties: { ...schema.properties, n: { type: "number", maximum: 2 } } }).request,
    { expectedRevision: revision });
  release.resolve();
  assert.equal((await mutation).success, true);
  assert.equal((await replacement).error.code, "REVISION_CONFLICT");
  assert.equal(await f.service.get("svc.n"), 3);
  assert.equal((await registry.getSchema("svc", "dev")).properties.n.maximum, undefined);
});

test("hywh/29r: publication uses the exact prevalidated resolved value, not a second backend read", async (t) => {
  let current = 1;
  const f = await initialized({ records: [record("svc", schema)], data: { svc: { n: { _weaver: "secret-ref", provider: "vault", uri: "n" } } },
    secretBackend: { resolve: async () => current } });
  t.after(() => f.service.close());
  const commit = f.platform.authority.commitLayer.bind(f.platform.authority);
  t.mock.method(f.platform.authority, "commitLayer", async (...args) => {
    const result = await commit(...args);
    current = "invalid-after-validation";
    return result;
  });
  const events = [];
  f.service.onDelta((delta) => events.push(delta));
  assert.equal((await f.service.set("platform", "svc.mode", "updated")).success, true);
  assert.deepEqual(events.map((event) => event.value), [{ n: 1, mode: "updated" }]);
  await assert.rejects(f.service.get("svc.n"));
});

test("fteq: read-only control and an unbound capability reject before lifecycle IO", async (t) => {
  const f = await scopedFixture(t, "retired");
  const proxy = createScopeManager({ configService: new Proxy(f.service, {}) });
  assert.equal((await proxy.provision({ scopePath: cold, actor: "admin" })).error.code, "FORBIDDEN");
  await f.service.close();
  const provider = { ...f.platform, writable: false, load: () => f.platform.load() };
  const service = await createWeaverConfigService({ providers: [provider, ...f.providers.slice(1)], environment: "dev" });
  t.after(() => service.close());
  const before = await provider.load();
  const revision = service.revision;
  const commit = t.mock.method(provider.authority, "commitLayer");
  const manager = createScopeManager({ configService: service });
  assert.equal((await manager.provision({ scopePath: cold, actor: "admin" })).error.code, "FORBIDDEN");
  assert.equal(commit.mock.callCount(), 0);
  assert.equal(service.revision, revision);
  assert.deepEqual(await provider.load(), before);
  assert.deepEqual(manager.listScopeValues("tenant"), []);
});

test("fteq: rejected provider promise reports uncertainty, publishes nothing and restarts from durable inventory", async (t) => {
  const f = await scopedFixture(t);
  const before = await f.platform.load();
  const events = [];
  f.service.onDelta((delta) => events.push(delta));
  const fault = t.mock.method(f.platform.authority, "commitLayer", async () => { throw new Error("injected unavailable acknowledgement"); });
  const manager = createScopeManager({ configService: f.service });
  const result = await manager.deprovision({ scopePath: cold, actor: "admin" });
  assert.equal(result.error.code, "COMMIT_OUTCOME_UNKNOWN");
  assert.deepEqual(await f.platform.load(), before);
  assert.deepEqual(events, []);
  await assert.rejects(f.service.resolveAll());
  fault.mock.restore();
  await f.service.close();
  const restarted = await createWeaverConfigService({ providers: f.providers, environment: "dev" });
  t.after(() => restarted.close());
  assert.deepEqual(createScopeManager({ configService: restarted }).listScopeValues("tenant"), ["cold"]);
});

test("9qje: real filesystem canonical registrations survive concurrent handles and reject duplicate owners", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-canonical-registry-"));
  let finalService;
  t.after(async () => { await finalService?.close(); await rm(directory, { recursive: true, force: true }); });
  const filePath = join(directory, "entries.json");
  const provider = () => createFileSystemStorageProvider({ id: "platform", layer: "platform", filePath,
    writable: true, authority: { environment: "dev", initialize: true } });
  const original = provider();
  const service = await initializeOwned({ providers: [original], environment: "dev", requireDurableAuthority: true },
    [{ id: "platform", factory: "fs", options: { filePath } }], {});
  finalService = service;
  const one = createSchemaRegistry({ configService: service });
  const two = createSchemaRegistry({ configService: service });
  const results = await Promise.all([one.register(record("one", { type: "object" }).request), two.register(record("two", { type: "object" }).request)]);
  assert.ok(results.every((result) => result.success));
  await assert.rejects(createWeaverConfigService({ providers: [provider()], environment: "dev" }), { code: "WRITER_CONFLICT" });
  await service.close();
  const restarted = await createWeaverConfigService({ providers: [provider()], environment: "dev" });
  finalService = restarted;
  assert.deepEqual(Object.keys(createSchemaRegistry({ configService: restarted }).listAll()).sort(), ["/one:dev", "/two:dev"]);
});

test("9qje/29r: conflicting creates preserve the winner and malformed context cannot reach persistence", async (t) => {
  const f = await initialized();
  t.after(() => f.service.close());
  const one = createSchemaRegistry({ configService: f.service });
  const two = createSchemaRegistry({ configService: f.service });
  const request = record("svc", schema).request;
  const commit = t.mock.method(f.platform.authority, "commitLayer");
  for (const context of [{ expectedRevision: 1 }, { actor: [] }, { subject: null }, { internal: true }]) {
    const result = await one.register(request, context);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "VALIDATION_ERROR");
  }
  assert.equal(commit.mock.callCount(), 0);
  const results = await Promise.all([
    one.register(request),
    two.register({ ...request, schema: { type: "object", properties: { n: { type: "string" } } } }),
  ]);
  assert.equal(results[0].success, true);
  assert.equal(results[1].error.code, "REVISION_CONFLICT");
  assert.equal(commit.mock.callCount(), 1);
  assert.equal((await two.getSchema("svc", "dev")).properties.n.type, "number");
});

for (const fragmentFirst of [false, true]) {
  test(`9qje: racing parent-slot changes cannot erase a successful fragment; fragment first=${fragmentFirst}`, async (t) => {
    const serviceRecord = record("svc", { type: "object", properties: { plugins: { type: "object" } } });
    serviceRecord.request.fragmentSlots = [{ slotPath: "/plugins", accepts: "object" }];
    const f = await initialized({ records: [serviceRecord], data: { svc: { plugins: {} } } });
    t.after(() => f.service.close());
    const registry = createSchemaRegistry({ configService: f.service });
    const revision = f.service.revision;
    const fragment = () => registry.register({ serviceId: "svc", environment: "dev", owner: serviceRecord.request.owner,
      providerId: "plugin", slotPath: "/plugins", schema: { type: "object" } }, { expectedRevision: revision });
    const parent = () => registry.register({ ...serviceRecord.request, fragmentSlots: [] }, { expectedRevision: revision });
    const operations = fragmentFirst ? [fragment, parent] : [parent, fragment];
    const results = await Promise.all(operations.map((operation) => operation()));
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, false);
    await f.service.close();
    const restarted = await createWeaverConfigService({ providers: f.providers, environment: "dev" });
    t.after(() => restarted.close());
    const canonical = (await f.platform.load()).entries._weaver.catalog.registrations;
    assert.equal(Object.values(canonical).some((record) => record.kind === "fragment"), fragmentFirst);
    const recovered = createSchemaRegistry({ configService: restarted });
    assert.equal((await recovered.resolveAnchor("/svc/plugins/plugin", "dev")).kind, fragmentFirst ? "fragment" : "service");
  });
}
