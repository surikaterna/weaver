import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepSet } from "@weaver-conf/config-engine";
import { createInMemoryStorageProvider, createFileSystemStorageProvider, createMongoDBStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { controlTransaction } from "../src/core/config-service-internal.ts";
import { createTestService } from "./setup-service.ts";
import { initializeOwned, numericSchema } from "./owned-fixtures.mjs";
import { createOverrideSessionProvider } from "../../config-sessions/src/override-session-provider.ts";
import { scopeContextId, validateScopeInventory } from "../src/core/scope-inventory.ts";

const malformed = ["__proto__.x", "constructor.x", "prototype.x", "a[", "a..b", "", "a[]", "[a]oops", "a]", "a."];
const emptyInventory = { version: 1, revision: "0", contexts: {} };
async function register(service) {
  const registry = createSchemaRegistry({ configService: service });
  const result = await registry.register({ serviceId: "svc", environment: "default", owner: { name: "test", contact: "test@example.com" }, fragmentSlots: [], schema: numericSchema }, { expectedRevision: service.revision });
  assert.equal(result.success, true, JSON.stringify(result));
  return registry;
}

for (const bound of [false, true]) test(`malformed core paths resolve typed failures with zero effects; registry handle=${bound}`, async () => {
  const provider = createInMemoryStorageProvider({ id: "p", layer: "platform", initialEntries: { svc: { a: 0 } } });
  const scope = createInMemoryStorageProvider({ id: "scoped", layer: "tenant" });
  const service = await createTestService({ providers: [provider, scope], environment: "default" }, { svc: numericSchema });
  if (bound) await register(service);
  const revision = service.revision;
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    for (const layer of ["platform", "tenant:cold"]) for (const key of malformed) {
      for (const result of await Promise.all([service.set(layer, key, 1), service.remove(layer, key), service.setMany(layer, { "svc.a": 2, [key]: 1 })])) {
        assert.equal(result.success, false, `${layer}:${key}`);
        assert.equal(result.error.code, "VALIDATION_ERROR");
      }
      assert.equal(service.revision, revision);
    }
    assert.deepEqual((await provider.load()).entries, { svc: { a: 0 } });
    assert.deepEqual((await scope.load()).entries, {});
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototype);
    assert.equal((await service.set("platform", "[svc][b]", 2)).success, true);
    assert.equal((await service.remove("platform", "svc.b")).success, true);
  } finally { await service.close(); }
});

for (const active of [false, true]) test(`malformed override paths preserve session; active=${active}`, async () => {
  const controller = createOverrideSessionProvider();
  if (active) controller.activate({ reason: "test", activatedBy: "tester" });
  try {
    const session = controller.getSession();
    for (const key of malformed) {
      assert.equal((await controller.provider.write(key, 1)).error.code, "VALIDATION_ERROR");
      assert.equal((await controller.provider.remove(key)).error.code, "VALIDATION_ERROR");
    }
    assert.deepEqual(await controller.provider.load(), { entries: {} });
    assert.deepEqual(controller.getSession(), session);
    assert.equal((await controller.provider.write("nested[key]", 1)).success, true);
    assert.equal((await controller.provider.remove("nested.key")).success, true);
  } finally { controller.dispose(); }
});

function barrierProvider() {
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const entries = { svc: { a: 0, b: 0 } };
  let writes = 0;
  return { id: "barrier", layer: "platform", writable: true, started, release, entries,
    async load() { return { entries: structuredClone(entries) }; },
    async write(key, value) { writes++; if (writes === 1) { entered(); await gate; } deepSet(entries, key, structuredClone(value)); return { success: true }; },
    async remove() { throw new Error("not used"); },
  };
}

for (const conditional of [true, false]) test(`registered RMW holds queue before prepare; conditional=${conditional}`, async () => {
  const provider = barrierProvider();
  const service = await createTestService({ providers: [provider], environment: "default" }, { svc: numericSchema });
  const registry = await register(service);
  const opts = { schemaRegistry: registry, ...(conditional ? { expectedRevision: service.revision } : {}) };
  const deltas = [];
  service.onDelta((delta) => deltas.push(delta));
  try {
    const one = service.patchRegisteredPath("platform", "/svc/a", 1, opts);
    await provider.started;
    const two = service.patchRegisteredPath("platform", "/svc/b", 2, opts);
    provider.release();
    const [first, second] = await Promise.all([one, two]);
    assert.equal(first.success, true);
    assert.equal(second.success, !conditional);
    if (conditional) assert.equal(second.error.code, "REVISION_CONFLICT");
    assert.deepEqual(await service.get("svc"), conditional ? { a: 1, b: 0 } : { a: 1, b: 2 });
    assert.deepEqual((await service.resolveAll()).entries, provider.entries);
    assert.equal((conditional ? first : second).revision, service.revision);
    assert.ok(deltas.length > 0);
  } finally { await service.close(); }
});

test("public/internal mixed operations share queue, and provider rejection retains revision", async () => {
  const provider = barrierProvider();
  const service = await createTestService({ providers: [provider], environment: "default" }, { svc: numericSchema });
  const registry = await register(service);
  try {
    const publicWrite = service.patchRegisteredPath("platform", "/svc/a", 1, { schemaRegistry: registry });
    await provider.started;
    const internal = registry.register({ serviceId: "other", environment: "default", owner: { name: "other", contact: "other@example.com" }, schema: numericSchema, fragmentSlots: [] });
    provider.release();
    assert.equal((await publicWrite).success, true);
    assert.equal((await internal).success, true);
    assert.deepEqual(await service.get("svc"), { a: 1, b: 0 });
    await assert.rejects(controlTransaction(service, "catalog", ({ write }) => write("svc.b", 2)), { code: "FORBIDDEN" });
    const revision = service.revision;
    provider.write = async () => ({ success: false, error: { code: "WRITE_ERROR", message: "injected" } });
    assert.equal((await service.set("platform", "svc.a", 3)).success, false);
    assert.equal(service.revision, revision);
  } finally { await service.close(); }
});

test("durable service restart preserves authority; reload/noop stable; ABA conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-core-service-"));
  const providerOptions = { id: "durable", layer: "platform", filePath: join(directory, "config.json"), writable: true, authority: { environment: "default", initialize: true } };
  const options = { environment: "default", requireDurableAuthority: true, scopeInventory: emptyInventory };
  let service;
  try {
    service = await initializeOwned({ ...options, providers: [createFileSystemStorageProvider(providerOptions)] }, [{ id: "durable", factory: "fs", options: { filePath: providerOptions.filePath } }]);
    const initial = service.revision;
    await service.reloadProvider("durable");
    await service.refreshProviders();
    assert.equal(service.revision, initial);
    await service.set("platform", "svc.a", 1);
    const first = service.revision;
    await service.set("platform", "svc.a", 1);
    assert.equal(service.revision, first);
    await service.set("platform", "svc.a", 2);
    await service.set("platform", "svc.a", 1);
    assert.notEqual(service.revision, first);
    const final = service.revision;
    await service.close();
    service = await createWeaverConfigService({ ...options, providers: [createFileSystemStorageProvider(providerOptions)] });
    assert.equal(service.revision, final);
    assert.equal((await service.set("platform", "svc.a", 3, { expectedRevision: first })).error.code, "REVISION_CONFLICT");
    assert.equal(JSON.parse(await readFile(providerOptions.filePath, "utf8")).entries.svc.a, 1);
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("required corrupt current envelope reload never serves an empty weaker configuration", async () => {
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "weaver-current-corruption-"));
  const filePath = join(directory, "entries.json");
  const provider = createFileSystemStorageProvider({ id: "current", layer: "platform", filePath, writable: true, authority: { environment: "default", initialize: true } });
  assert.equal((await provider.write("billing", { plan: "current" })).success, true);
  const service = await createTestService({ providers: [provider], environment: "default" }, { billing: { type: "object", properties: { plan: { type: "string" } }, additionalProperties: false } });
  const original = await readFile(filePath, "utf8");
  const revision = service.revision;
  const deltas = [];
  service.onDelta((delta) => deltas.push(delta));
  try {
    for (const corrupt of ["not JSON", JSON.stringify({ ...JSON.parse(original), sequence: "bad" }), JSON.stringify({ ...JSON.parse(original), storageFormat: 99 })]) {
      await writeFile(filePath, corrupt);
      await assert.rejects(provider.load(), { code: "PROVIDER_CORRUPT" });
      await assert.rejects(service.reloadProvider("current"), { code: "PROVIDER_LOAD_FAILED" });
      await assert.rejects(service.resolveAll(), { code: "PROVIDER_LOAD_FAILED" });
      await assert.rejects(service.get("billing"), { code: "PROVIDER_LOAD_FAILED" });
      assert.equal(service.revision, revision);
      assert.equal(deltas.length, 0);
      assert.equal(await readFile(filePath, "utf8"), corrupt);
      await writeFile(filePath, original);
      await service.reloadProvider("current");
      assert.deepEqual(await service.get("billing"), { plan: "current" });
    }
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("complete inventory validates cold combinations/prefixes and refuses unknown context", async () => {
  const prefix = [{ scopeId: "tenant", value: "cold" }];
  const full = [...prefix, { scopeId: "region", value: "eu" }];
  const contexts = Object.fromEntries([prefix, full].map((scopePath) => [scopeContextId(scopePath), { scopePath, state: "active" }]));
  const inventory = validateScopeInventory({ version: 1, revision: "0", contexts });
  assert.throws(() => validateScopeInventory({ ...inventory, contexts: { [scopeContextId(full)]: contexts[scopeContextId(full)] } }), { code: "VALIDATION_ERROR" });
  const providers = [createInMemoryStorageProvider({ id: "t", layer: "tenant" }), createInMemoryStorageProvider({ id: "r", layer: "region" })];
  await providers[0].loadLayer("tenant:cold");
  await providers[1].loadLayer("region:eu");
  const service = await createTestService({ providers, environment: "default", scopeInventory: inventory }, { svc: numericSchema }, [prefix, full]);
  try {
    const snapshot = await service.resolveAll();
    assert.equal(Object.keys(snapshot.scopes).length, 2);
    const authority = await service.authoritySnapshot();
    assert.equal(authority.revision, service.revision);
    assert.equal(authority.providers.t.inventory.revisions.length, 2);
    assert.equal(authority.providers.r.inventory.revisions.length, 2);
    assert.deepEqual(authority.inventory, inventory);
     assert.equal((await service.set("tenant:unknown", "svc.a", 1)).error.code, "SCOPE_NOT_FOUND");
    await assert.rejects(service.resolveAll({ scopePath: [{ scopeId: "tenant", value: "unknown" }] }), { code: "SCOPE_NOT_FOUND" });
    await assert.rejects(createWeaverConfigService({ providers: [createInMemoryStorageProvider({ id: "v", layer: "platform" })], environment: "default", scopeInventory: emptyInventory, requireDurableAuthority: true }), { code: "UNSUPPORTED_AUTHORITY" });
  } finally { await service.close(); }
});

test("uncertain core acknowledgement blocks reads/reload/publication and signals nonready", async () => {
  const state = { svc: { a: 0 } };
  const readiness = [];
  const provider = { id: "uncertain", layer: "platform", writable: true,
    async load() { return { entries: structuredClone(state) }; },
    async write(key, value) { deepSet(state, key, value); return { success: false, error: { code: "COMMIT_OUTCOME_UNKNOWN", message: "injected lost acknowledgement" } }; },
    async remove() { return { success: false }; },
  };
  const service = await createTestService({ providers: [provider], environment: "default", onReadinessChange: (ready) => readiness.push(ready) }, { svc: numericSchema });
  readiness.length = 0;
  const deltas = [];
  service.onDelta((delta) => deltas.push(delta));
  const revision = service.revision;
  try {
    const result = await service.set("platform", "svc.a", 1);
    assert.equal(result.error.code, "COMMIT_OUTCOME_UNKNOWN");
    assert.equal(state.svc.a, 1);
    assert.equal(service.revision, revision);
    await assert.rejects(service.get("svc.a"), { code: "COMMIT_OUTCOME_UNKNOWN" });
    await assert.rejects(service.reloadProvider(provider.id), { code: "COMMIT_OUTCOME_UNKNOWN" });
    assert.equal(deltas.length, 0);
    assert.deepEqual(readiness, [false]);
  } finally { await service.close(); }
});

test("setMany checks expected revision once and reports an intentional committed prefix", async () => {
  const entries = {};
  let writes = 0;
  const provider = { id: "partial", layer: "platform", writable: true,
    async load() { return { entries: structuredClone(entries) }; },
    async write(key, value) { if (++writes === 2) return { success: false, error: { code: "WRITE_ERROR", message: "injected second-item failure" } }; deepSet(entries, key, value); return { success: true }; },
    async remove() { return { success: true }; },
  };
  const service = await createTestService({ providers: [provider], environment: "default" }, { svc: numericSchema });
  try {
    const before = service.revision;
    const result = await service.setMany("platform", { "svc.a": 1, "svc.b": 2, "svc.c": 3 }, { expectedRevision: before });
    assert.equal(result.error.code, "WRITE_ERROR");
    assert.equal(result.revision, service.revision);
    assert.notEqual(service.revision, before);
    assert.deepEqual(entries, { svc: { a: 1 } });
    assert.deepEqual((await service.resolveAll()).entries, entries);
  } finally { await service.close(); }
});

for (const scoped of [false, true]) test(`owned adapter mixed set/remove/registered races preserve physical and live state; scoped=${scoped}`, async () => {
  const layer = scoped ? "tenant:one" : "platform";
  const provider = createInMemoryStorageProvider({ id: "owned", layer: scoped ? "tenant" : "platform", initialEntries: { svc: {} } });
  await provider.writeLayer(layer, "svc", { a: 0, b: 0 });
  const service = await createTestService({ providers: [provider], environment: "default" }, { svc: numericSchema }, scoped ? [[{ scopeId: "tenant", value: "one" }]] : []);
  const registry = await register(service);
  const readOptions = scoped ? { scopePath: [{ scopeId: "tenant", value: "one" }] } : undefined;
  try {
    await service.resolveAll(readOptions);
    const expectedRevision = service.revision;
    const sameRevision = await Promise.all([
      service.patchRegisteredPath(layer, "/svc/a", 1, { schemaRegistry: registry, expectedRevision }),
      service.patchRegisteredPath(layer, "/svc/b", 2, { schemaRegistry: registry, expectedRevision }),
    ]);
    assert.equal(sameRevision.filter((result) => result.success).length, 1);
    assert.equal(sameRevision.find((result) => !result.success).error.code, "REVISION_CONFLICT");
    const mixed = await Promise.all([
      service.patchRegisteredPath(layer, "/svc/a", 3, { schemaRegistry: registry }),
      service.set(layer, "svc.b", 4),
      service.remove(layer, "svc.a"),
    ]);
    assert.ok(mixed.every((result) => result.success));
    assert.deepEqual((await provider.loadLayer(layer)).entries, { svc: { b: 4 } });
    assert.deepEqual(await service.get("svc", readOptions), { b: 4 });
    assert.equal(mixed.at(-1).revision, (await service.resolveAll(readOptions)).revision);
  } finally { await service.close(); }
});
