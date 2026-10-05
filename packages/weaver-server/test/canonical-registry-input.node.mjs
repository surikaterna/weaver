import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createSchemaRegistry, createPersistentSchemaRegistry } from "../src/core/schema-registry.ts";
import { assertRejected, proxyHazard, registrationHazards } from "../../config-registry/test/fixtures/registration-hazards.mjs";
import { fragment, service } from "../../config-registry/test/fixtures/requests.mjs";

async function harness(persistent) {
  const provider = createInMemoryStorageProvider({ id: "platform", layer: "platform" });
  const rawLoad = provider.load.bind(provider);
  const calls = {};
  for (const name of ["load", "loadLayer", "write", "writeLayer", "remove", "removeLayer"]) {
    const original = provider[name].bind(provider);
    calls[name] = 0;
    provider[name] = (...args) => { calls[name]++; return original(...args); };
  }
  const configService = await createWeaverConfigService({ providers: [provider], environment: "dev" });
  const registry = persistent ? await createPersistentSchemaRegistry({ configService }) : createSchemaRegistry({ configService });
  assert.equal((await registry.register(service())).success, true);
  const deltas = [];
  configService.onDelta(delta => deltas.push(delta));
  return { provider, rawLoad, calls, configService, registry, deltas };
}

function resetEffects(subject) {
  for (const key of Object.keys(subject.calls)) subject.calls[key] = 0;
  subject.deltas.length = 0;
}

async function snapshot(subject) {
  const cursor = subject.registry.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor;
  return {
    schemas: subject.registry.listAll(), identities: subject.registry.listRegisteredSchemaIdentities(),
    bytes: structuredClone(await subject.rawLoad()), revision: subject.configService.revision,
    cursor, continuation: subject.registry.listRegisteredSchemaIdentityPage({ cursor }),
  };
}

async function assertUnchanged(subject, before) {
  assert.deepEqual(subject.registry.listAll(), before.schemas);
  assert.deepEqual(subject.registry.listRegisteredSchemaIdentities(), before.identities);
  assert.deepEqual(await subject.rawLoad(), before.bytes);
  assert.equal(subject.configService.revision, before.revision);
  assert.deepEqual(subject.registry.listRegisteredSchemaIdentityPage({ cursor: before.cursor }), before.continuation);
  assert.deepEqual(Object.values(subject.calls), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(subject.deltas, []);
}

for (const persistent of [false, true]) {
  test(`${persistent ? "persistent" : "transient"}: all registration descriptor hazards have zero getters/provider effects and unchanged state`, async () => {
    const subject = await harness(persistent);
    const cases = [...registrationHazards("service"), ...registrationHazards("fragment"), proxyHazard()];
    for (const [index, item] of cases.entries()) {
      const before = await snapshot(subject);
      resetEffects(subject);
      assertRejected(assert, await subject.registry.register(item.request, item.context));
      assert.equal(item.calls(), 0, item.name);
      await assertUnchanged(subject, before);
      assert.equal((await subject.registry.register(service(`recovery${index}`))).success, true);
      assert.equal((await subject.registry.register(fragment(`recovery${index}`))).success, true);
    }
    assert.equal(cases.at(-1).reflections(), 1);
    console.log(`${persistent ? "persistent" : "transient"}: ${cases.length} hazards; getters=0, provider load/loadLayer/write/writeLayer/remove/removeLayer=0, deltas=0; schema/slot/index/bytes/revision/cursor unchanged after each rejection`);
  });

  test(`${persistent ? "persistent" : "transient"}: queued caller mutation is revalidated at consumption`, async () => {
    const subject = await harness(persistent);
    for (const field of ["serviceId", "environment", "actor", "payload"]) await queuedMutation(subject, field);
  });

  test(`${persistent ? "persistent" : "transient"}: missing/empty/explicit environment semantics and plain null-prototype data are preserved`, async () => {
    for (const environment of [undefined, "", "explicit"]) {
      const subject = await harness(persistent);
      const request = Object.assign(Object.create(null), service(environment));
      if (environment === undefined) delete request.environment;
      const result = await subject.registry.register(request, Object.assign(Object.create(null), { subject: "host" }));
      assert.equal(result.success, persistent || environment === "explicit");
      if (result.success) assert.equal(result.metadata.environment, environment || "dev");
      assert.equal(request.environment, environment);
      assert.equal(Object.getPrototypeOf(request), null);
      assert.equal(Object.isFrozen(request), false);
    }
  });
}

async function queuedMutation(subject, field) {
  const before = await snapshot(subject);
  let release;
  let entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const original = subject.provider.write;
  subject.provider.write = async (...args) => { entered(); await waiting; return original(...args); };
  resetEffects(subject);
  const write = subject.configService.set("platform", "svc.name", `queued write ${field}`);
  await started;
  const request = service("pending");
  const context = { actor: "host" };
  const registration = subject.registry.register(request, context);
  let calls = 0;
  installQueuedGetter(request, context, field, () => { calls++; throw new Error("queued getter"); });
  release();
  assert.equal((await write).success, true);
  const revision = subject.configService.revision;
  assertRejected(assert, await registration);
  assert.equal(calls, 0);
  assert.deepEqual(subject.registry.listAll(), before.schemas);
  assert.deepEqual(subject.registry.listRegisteredSchemaIdentities(), before.identities);
  assert.deepEqual(subject.registry.listRegisteredSchemaIdentityPage({ cursor: before.cursor }), before.continuation);
  assert.deepEqual((await subject.rawLoad()).entries._weaver, before.bytes.entries._weaver);
  assert.equal(subject.configService.revision, revision);
  assert.equal(subject.calls.write, 1);
  assert.deepEqual(Object.entries(subject.calls).filter(([key]) => key !== "write").map(([, count]) => count), [0, 0, 0, 0, 0]);
  assert.equal(subject.deltas.length, 1);
  subject.provider.write = original;
  assert.equal((await subject.registry.register(service("recovered"))).success, true);
}

function installQueuedGetter(request, context, field, getter) {
  if (field === "actor") Object.defineProperty(context, field, { get: getter, enumerable: true });
  else if (field === "payload") {
    request.schema.properties.name.default = {};
    Object.defineProperty(request.schema.properties.name.default, field, { get: getter, enumerable: true });
  } else Object.defineProperty(request, field, { get: getter, enumerable: true });
}
