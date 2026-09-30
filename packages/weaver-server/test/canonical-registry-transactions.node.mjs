import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createSchemaRegistry, createPersistentSchemaRegistry } from "../src/core/schema-registry.ts";
import { fragment, service } from "../../config-registry/test/fixtures/requests.mjs";

function controlledProvider() {
  const provider = createInMemoryStorageProvider({ id: "platform", layer: "platform" });
  const original = provider.write.bind(provider);
  const calls = [];
  let next;
  provider.write = async (...args) => {
    calls.push(args);
    const action = next;
    next = undefined;
    if (action) return action(...args);
    return original(...args);
  };
  return { provider, calls, fail() { next = async () => ({ success: false, error: { code: "WRITE_ERROR", message: "offline" } }); },
    reject(error) { next = async () => { throw error; }; },
    pause() {
      let release;
      let entered;
      const waiting = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      next = async (...args) => { entered(); await waiting; return original(...args); };
      return { started, release };
    },
  };
}

for (const persistent of [false, true]) {
  test(`${persistent ? "persistent" : "transient"} binding, rejected registration and strict write gates preserve provider effects`, async () => {
    const controls = controlledProvider();
    const configService = await createWeaverConfigService({ providers: [controls.provider], environment: "dev" });
    const registry = persistent ? await createPersistentSchemaRegistry({ configService }) : createSchemaRegistry({ configService });
    assert.throws(() => createSchemaRegistry({ configService }), /already has/);
    await assert.rejects(createPersistentSchemaRegistry({ configService }), /already has/);
    const revision = configService.revision;
    assert.equal((await configService.set("platform", "svc.name", "bad")).error.code, "SCHEMA_NOT_REGISTERED");
    assert.equal(controls.calls.length, 0);
    assert.equal(configService.revision, revision);
    assert.equal((await registry.register(service())).success, true);
    const identities = registry.listRegisteredSchemaIdentities();
    const cursor = registry.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor;
    const writes = controls.calls.length;
    assert.equal((await registry.register(fragment("absent"))).success, false);
    assert.deepEqual(registry.listRegisteredSchemaIdentities(), identities);
    assert.doesNotThrow(() => registry.listRegisteredSchemaIdentityPage({ cursor }));
    assert.equal((await configService.set("platform", "svc.name", 42)).error.code, "VALIDATION_ERROR");
    assert.equal((await configService.set("platform", "other.name", "bad")).error.code, "SCHEMA_NOT_REGISTERED");
    assert.equal(controls.calls.length, writes);
    assert.equal((await configService.set("platform", "svc.name", "ok")).success, true);
    assert.equal(await configService.get("svc.name"), "ok");
    const stalled = controls.pause();
    const write = configService.set("platform", "svc.name", "queued");
    await stalled.started;
    const registration = registry.register(service("next"));
    assert.equal(await registry.getSchema("svc", "next"), null);
    stalled.release();
    assert.equal((await write).success, true);
    assert.equal((await registration).success, true);
    assert.throws(() => registry.listRegisteredSchemaIdentityPage({ cursor }), { code: "REVISION_CONFLICT" });
  });
}

test("failed persistence leaves state/index/cursor/revision/bytes unchanged and registration queue recovers", async () => {
  const controls = controlledProvider();
  const configService = await createWeaverConfigService({ providers: [controls.provider], environment: "dev" });
  const registry = await createPersistentSchemaRegistry({ configService });
  await registry.register(service());
  const bytes = await controls.provider.load();
  const identities = registry.listRegisteredSchemaIdentities();
  const revision = configService.revision;
  const cursor = registry.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor;
  controls.fail();
  assert.equal((await registry.register(service("failed"))).error.code, "INTERNAL_ERROR");
  assert.deepEqual(await controls.provider.load(), bytes);
  assert.deepEqual(registry.listRegisteredSchemaIdentities(), identities);
  assert.equal(await registry.getSchema("svc", "failed"), null);
  assert.equal(configService.revision, revision);
  assert.doesNotThrow(() => registry.listRegisteredSchemaIdentityPage({ cursor }));
  const rejection = new Error("provider rejected");
  controls.reject(rejection);
  await assert.rejects(registry.register(service("rejected")), error => error === rejection);
  assert.deepEqual(await controls.provider.load(), bytes);
  assert.deepEqual(registry.listRegisteredSchemaIdentities(), identities);
  assert.equal(configService.revision, revision);
  assert.doesNotThrow(() => registry.listRegisteredSchemaIdentityPage({ cursor }));
  const stalled = controls.pause();
  const first = registry.register(service("queued"));
  await stalled.started;
  const second = registry.register(fragment("queued"));
  const write = configService.set("platform", "svc.name", "after registration");
  assert.equal(await registry.getSchema("svc", "queued"), null);
  assert.doesNotThrow(() => registry.listRegisteredSchemaIdentityPage({ cursor }));
  stalled.release();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.equal((await write).success, true);
  assert.throws(() => registry.listRegisteredSchemaIdentityPage({ cursor }), { code: "REVISION_CONFLICT" });
  const restartedService = await createWeaverConfigService({ providers: [controls.provider], environment: "dev" });
  const restarted = await createPersistentSchemaRegistry({ configService: restartedService });
  assert.deepEqual(restarted.listRegisteredSchemaIdentities(), registry.listRegisteredSchemaIdentities());
  assert.throws(() => restarted.listRegisteredSchemaIdentityPage({ cursor: registry.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor }), { code: "REVISION_CONFLICT" });
});

test("writes during pending hydration cannot bypass binding or schema admission", async () => {
  const controls = controlledProvider();
  const configService = await createWeaverConfigService({ providers: [controls.provider], environment: "dev" });
  const hydration = createPersistentSchemaRegistry({ configService });
  assert.throws(() => createSchemaRegistry({ configService }), /already has/);
  await assert.rejects(createPersistentSchemaRegistry({ configService }), /already has/);
  const write = configService.set("platform", "svc.name", "unregistered");
  const registry = await hydration;
  assert.equal((await write).error.code, "SCHEMA_NOT_REGISTERED");
  assert.equal(controls.calls.length, 0);
  assert.equal((await registry.register(service())).success, true);
  assert.equal((await configService.set("platform", "svc.name", "registered")).success, true);
});
