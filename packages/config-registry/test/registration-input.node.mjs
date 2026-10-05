import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCanonicalSchemaRegistry } from "../dist/index.js";
import { createRegistryAdapter } from "../dist/internal/server-adapter.js";
import { assertRejected, proxyHazard, registrationHazards } from "./fixtures/registration-hazards.mjs";
import { fragment, service } from "./fixtures/requests.mjs";
import { sourceModule } from "./fixtures/load-source.mjs";

function boundary(internal) {
  if (!internal) {
    const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "dev" });
    return { reader: registry, register: (q, c) => registry.register(q, c) };
  }
  const adapter = createRegistryAdapter({ defaultEnvironment: "dev" });
  return { reader: adapter.reader, register(q, c) {
    const prepared = adapter.prepare(q, c);
    if (prepared.result.success) prepared.publish();
    else { assert.equal(prepared.candidate, undefined); prepared.publish(); }
    return prepared.result;
  } };
}

for (const internal of [false, true]) {
  test(`${internal ? "internal prepare" : "root register"}: descriptor hazards reject with zero getters and unchanged authority`, () => {
    const target = boundary(internal);
    assert.equal(target.register(service()).success, true);
    const cases = [...registrationHazards("service"), ...registrationHazards("fragment"), proxyHazard()];
    for (const [index, item] of cases.entries()) {
      const before = { schemas: target.reader.listAll(), identities: target.reader.listRegisteredSchemaIdentities() };
      const cursor = target.reader.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor;
      assertRejected(assert, target.register(item.request, item.context));
      assert.equal(item.calls(), 0, item.name);
      assert.deepEqual({ schemas: target.reader.listAll(), identities: target.reader.listRegisteredSchemaIdentities() }, before);
      assert.doesNotThrow(() => target.reader.listRegisteredSchemaIdentityPage({ cursor }));
      assert.equal(target.register(service(`recovery${index}`)).success, true);
      assert.equal(target.register(fragment(`recovery${index}`)).success, true);
    }
    assert.equal(cases.at(-1).reflections(), 1);
    console.log(`${internal ? "internal" : "root"}: ${cases.length} hazards; getters=0; state/index/cursor unchanged; real registration recovery after each`);
  });
}

test("plain null-prototype, frozen data and shared acyclic object/array graphs remain detached and accepted", () => {
  for (const internal of [false, true]) {
    const target = boundary(internal);
    const payload = { literal: "original" };
    const array = Object.freeze([payload, payload, null, true, 3]);
    const shared = { type: "string", default: array };
    const request = Object.assign(Object.create(null), service());
    request.owner = Object.assign(Object.create(null), request.owner);
    request.schema = Object.assign(Object.create(null), { type: "object", properties: { one: shared, two: shared } });
    request.schemaVersion = undefined;
    const descriptor = Object.getOwnPropertyDescriptor(request, "serviceId");
    assert.equal(target.register(request, Object.assign(Object.create(null), { actor: "host" })).success, true);
    assert.equal(Object.getPrototypeOf(request), null);
    assert.deepEqual(Object.getOwnPropertyDescriptor(request, "serviceId"), descriptor);
    assert.equal(Object.isFrozen(request), false);
    assert.equal(Object.isFrozen(shared), false);
    payload.literal = "caller";
    const read = target.reader.getSchema("svc", "dev");
    assert.equal(read.properties.one, read.properties.two);
    assert.equal(read.properties.one.default[0], read.properties.one.default[1]);
    assert.equal(read.properties.one.default[0].literal, "original");
  }
});

test("private descriptor traversal snapshots deep/shared graphs iteratively and catches uncertain reflection", async () => {
  const { snapshotPlainData } = await sourceModule(fileURLToPath(new URL("../src/plain-data-graph.ts", import.meta.url)));
  let deep = { leaf: undefined };
  for (let index = 0; index < 20000; index++) deep = { child: deep };
  const shared = [deep, deep];
  const result = snapshotPlainData(shared);
  assert.equal(result.success, true);
  assert.equal(result.value[0], result.value[1]);
  let leaf = result.value[0];
  for (let index = 0; index < 20000; index++) leaf = leaf.child;
  assert.equal(Object.hasOwn(leaf, "leaf"), true);
  assert.equal(leaf.leaf, undefined);
  assert.equal(Object.getPrototypeOf(leaf), null);
  assert.deepEqual(snapshotPlainData([undefined, null, "text", true, 0]).value, [undefined, null, "text", true, 0]);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(snapshotPlainData(revoked.proxy).success, false);
});

test("internal fallback is applied only after guarding; pure root retains no-fallback semantics", () => {
  for (const environment of [undefined, "", "explicit"]) {
    const request = service(environment);
    if (environment === undefined) delete request.environment;
    const root = boundary(false);
    assert.equal(root.register(request).success, environment === "explicit");
    const adapter = createRegistryAdapter({ defaultEnvironment: "dev" });
    const prepared = adapter.prepare(request, { subject: "host" }, "fallback");
    assert.equal(prepared.result.success, true);
    assert.equal(prepared.environment, environment || "fallback");
    assert.deepEqual(prepared.context, { subject: "host" });
    assert.equal(request.environment, environment);
  }
});
