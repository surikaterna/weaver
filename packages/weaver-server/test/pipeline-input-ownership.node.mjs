import assert from "node:assert/strict";
import { test } from "node:test";
import { internalRegistrationId } from "@weaver-conf/config-types";
import { controlTransaction } from "../src/core/config-service-internal.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { initialized, record } from "./validated-fixtures.mjs";

const secret = { _weaver: "secret-ref", provider: "vault", uri: "secret" };
const schema = { type: "object", required: ["n", "secret"], properties: {
  n: { type: "number" }, secret: { type: "number" },
  settings: { type: "object", required: ["n"], properties: { n: { type: "number" } }, additionalProperties: false },
}, additionalProperties: false };

async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Operation did not settle within 1000ms")), 1000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture(t) {
  let barrier;
  let armed = false;
  const f = await initialized({ records: [record("svc", schema)],
    data: { svc: { n: 1, settings: { n: 1 }, secret } },
    secretBackend: { resolve: async () => {
      if (armed) { armed = false; barrier.entered.resolve(); await barrier.release.promise; }
      return 5;
    } },
  });
  t.after(async () => { barrier?.release.resolve(); await within(f.service.close()); });
  const registry = createSchemaRegistry({ configService: f.service });
  return { ...f, registry, arm() {
    barrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    armed = true;
    return barrier;
  } };
}

for (const form of ["ordinary", "object", "patch", "batch"]) {
  test(`P1: ${form} validates, persists and publishes an owned value across resolver await`, async (t) => {
    const f = await fixture(t);
    const value = form === "patch" ? { n: 2 } : { n: 2, settings: { n: 2 }, secret: { ...secret } };
    const options = { schemaRegistry: f.registry, expectedRevision: f.service.revision, environment: "dev" };
    const events = [];
    f.service.onDelta((event) => events.push(event));
    const gate = f.arm();
    const write = form === "ordinary" ? f.service.set("platform", "svc", value, { expectedRevision: options.expectedRevision, environment: "dev" })
      : form === "object" ? f.service.setRegisteredObject("platform", "/svc", value, options)
      : form === "patch" ? f.service.patchRegisteredPath("platform", "/svc/settings", value, options)
      : f.service.setMany("platform", { svc: value }, { expectedRevision: options.expectedRevision });
    await within(gate.entered.promise);
    value.n = "INVALID-AFTER-CANDIDATE";
    if (value.settings) value.settings.n = "INVALID-NESTED";
    options.expectedRevision = "changed-after-precondition";
    options.environment = "wrong";
    gate.release.resolve();
    assert.equal((await write).success, true);
    const stored = (await f.platform.load()).entries.svc;
    const published = events.at(-1).value;
    assert.equal(form === "patch" ? stored.settings.n : stored.n, 2);
    assert.equal(form === "patch" ? published.settings.n : published.n, 2);
    assert.equal(published.secret, 5);
    assert.equal((await f.service.get("svc")).settings.n, 2);
    assert.equal(events.at(-1).environment, "dev");
  });
}

test("P1: an internal registration record cannot change its schema after candidate validation", async (t) => {
  const f = await fixture(t);
  const item = record("other", { type: "object", properties: { n: { type: "number" } } });
  const id = internalRegistrationId(item);
  const gate = f.arm();
  const write = controlTransaction(f.service, "catalog", ({ write }) =>
    write(`_weaver.catalog.registrations.${id}`, item, { expectedRevision: f.service.revision }));
  await within(gate.entered.promise);
  item.request.schema.type = "string";
  item.request.schema.properties.n.type = "string";
  gate.release.resolve();
  assert.equal((await write).success, true);
  const stored = (await f.platform.load()).entries._weaver.catalog.registrations[id];
  assert.equal(stored.request.schema.type, "object");
  assert.equal(stored.request.schema.properties.n.type, "number");
  assert.equal((await f.registry.getSchema("other", "dev")).type, "object");
  assert.equal(await f.service.get("svc.n"), 1);
});

test("P1: queue admission captures values, preconditions, registry methods and registration requests", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const held = controlTransaction(f.service, "catalog", async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    const invalidContext = { expectedRevision: "stale" };
    const rejected = f.service.set("platform", "svc.n", 9, invalidContext);
    invalidContext.expectedRevision = f.service.revision;
    const value = { n: 2, secret: { ...secret } };
    const suppliedRegistry = { ...f.registry };
    const context = { expectedRevision: f.service.revision, schemaRegistry: suppliedRegistry };
    const accepted = f.service.setRegisteredObject("platform", "/svc", value, context);
    suppliedRegistry.resolveAnchor = async () => { throw new Error("Uncaptured registry method"); };
    value.n = "changed-in-queue";
    context.expectedRevision = "changed-in-queue";
    const request = record("other", { type: "object" }).request;
    const registration = f.registry.register(request);
    request.schema.type = "string";
    release.resolve();
    await held;
    assert.equal((await rejected).error.code, "REVISION_CONFLICT");
    assert.equal((await accepted).success, true);
    assert.equal((await registration).success, true);
    assert.equal(await f.service.get("svc.n"), 2);
    assert.equal((await f.registry.getSchema("other", "dev")).type, "object");
  } finally { release.resolve(); await held; }
});

test("P1: non-detachable inputs fail with a typed error before any provider effect", async (t) => {
  const f = await fixture(t);
  const before = await f.platform.load();
  const revision = f.service.revision;
  const value = { n: () => 2 };
  const context = { schemaRegistry: f.registry };
  for (const operation of [
    () => f.service.set("platform", "svc", value),
    () => f.service.setMany("platform", { svc: value }),
    () => f.service.setRegisteredObject("platform", "/svc", value, context),
    () => f.service.patchRegisteredPath("platform", "/svc/settings", value, context),
    () => controlTransaction(f.service, "catalog", ({ write }) => write("_weaver.catalog.registrations.invalid", value)),
  ]) await assert.rejects(operation(), { code: "VALIDATION_ERROR" });
  assert.equal(f.service.revision, revision);
  assert.deepEqual(await f.platform.load(), before);
});
