import assert from "node:assert/strict";
import { test } from "node:test";
import { controlTransaction } from "../src/core/config-service-internal.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { initialized, record } from "./validated-fixtures.mjs";

async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Operation did not settle within 1000ms")), 1000);
  })]); } finally { clearTimeout(timer); }
}

test("P2: reentrant public and nested control operations reject without poisoning the coordinator or close", async (t) => {
  const f = await initialized({ records: [record("svc", { type: "object", properties: { n: { type: "number" } } })], data: { svc: { n: 1 } } });
  t.after(() => within(f.service.close()));
  const registry = createSchemaRegistry({ configService: f.service });
  const context = { schemaRegistry: registry };
  const operations = [
    () => f.service.resolveAll(), () => f.service.get("svc.n"), () => f.service.getNamespace("svc"),
    () => f.service.inspect("svc.n"), () => f.service.set("platform", "svc.n", 2),
    () => f.service.setMany("platform", { "svc.n": 2 }), () => f.service.remove("platform", "svc.n"),
    () => f.service.setRegisteredObject("platform", "/svc", { n: 2 }, context),
    () => f.service.patchRegisteredPath("platform", "/svc/n", 2, context),
    () => f.service.validateRegisteredEffective("/svc", context), () => f.service.flush(),
    () => f.service.reloadProvider("platform"), () => f.service.refreshProviders(),
    () => f.service.authoritySnapshot(), () => f.service.batch(async () => {}), () => f.service.close(),
    () => controlTransaction(f.service, "scope", async () => {}),
  ];
  const before = await f.platform.load();
  const revision = f.service.revision;
  for (const operation of operations) {
    await assert.rejects(within(controlTransaction(f.service, "catalog", operation)), { code: "FORBIDDEN" });
    assert.equal(await within(f.service.get("svc.n")), 1);
  }
  const nested = await within(controlTransaction(f.service, "catalog", () => registry.register(record("other", { type: "object" }).request)));
  assert.equal(nested.error.code, "FORBIDDEN");
  assert.equal(f.service.revision, revision);
  assert.deepEqual(await f.platform.load(), before);
  assert.equal((await f.service.set("platform", "svc.n", 2)).success, true);
  await within(f.service.close());
});

test("P2: independent callers remain queued, and asynchronous descendants can run after ownership ends", async (t) => {
  const f = await initialized();
  t.after(() => within(f.service.close()));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const later = Promise.withResolvers();
  let descendant;
  const held = controlTransaction(f.service, "catalog", async () => {
    descendant = later.promise.then(() => f.service.resolveAll());
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  let settled = false;
  const independent = f.service.resolveAll().then((value) => { settled = true; return value; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  } finally { release.resolve(); await within(held); later.resolve(); }
  assert.deepEqual((await within(independent)).entries, {});
  assert.deepEqual((await within(descendant)).entries, {});
});

for (const family of ["catalog", "scope", "bootstrap", "maintenance"]) {
  test(`P4: escaped ${family} read/write capabilities reject after callback and service close`, async (t) => {
    const f = await initialized();
    t.after(() => within(f.service.close()));
    let escaped;
    await controlTransaction(f.service, family, async (transaction) => {
      escaped = transaction;
      assert.equal(typeof transaction.read(), "object");
    });
    assert.throws(() => escaped.read(), { code: "FORBIDDEN" });
    await assert.rejects(escaped.write("_weaver", {}), { code: "FORBIDDEN" });
    await within(f.service.close());
    assert.throws(() => escaped.read(), { code: "FORBIDDEN" });
    await assert.rejects(escaped.write("_weaver", {}), { code: "FORBIDDEN" });
  });
}

test("P4: live capabilities also check readiness when an independent close shuts admission", async () => {
  const f = await initialized();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const transaction = controlTransaction(f.service, "catalog", async ({ read, write }) => {
    entered.resolve(); await release.promise;
    assert.throws(read, { code: "SERVER_DEGRADED" });
    await assert.rejects(write("_weaver.catalog.registrations.none", {}), { code: "SERVER_DEGRADED" });
  });
  await entered.promise;
  const closing = f.service.close();
  release.resolve();
  await within(transaction);
  await within(closing);
});
