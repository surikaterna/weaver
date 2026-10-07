import assert from "node:assert/strict";
import { test } from "node:test";
import { hosted, principal, readonlyHost } from "./fixtures/authority.mjs";
import { MemoryProvider, options, registration } from "./fixtures/memory.mjs";

test("private queued-delivery guard reprojects both issued generations and suppresses revoked/disposed registrations", async () => {
  const { register } = await import("tsx/esm/api");
  const unregister = register();
  try {
  const { createReaderSubscriptions } = await import("../src/reader-subscriptions.ts");
  const { resolveConfigurationSnapshot } = await import("@weaver-conf/config-engine");
  const { createRegistryAdapter } = await import("@weaver-conf/config-registry/internal/server-adapter");
  const { createRegisteredReadProjection } = await import("@weaver-conf/config-registry");
  const { createWeaverError } = await import("@weaver-conf/config-types");
  const adapter = createRegistryAdapter({ defaultEnvironment: "east" });
  const schema = registration("east", "alpha", { type: "object", properties: { flag: { type: "string" } } });
  adapter.prepare(schema).publish();
  const identity = { environment: "east", scopePath: [] }, selection = { identity, namespace: "/alpha" };
  const snapshot = (value, revision) => {
    const raw = resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [], layers: [{ layer: "base", providerId: "p", rank: 0, entries: { alpha: { flag: value } } }] });
    return { identity, revision, registryRevision: adapter.revision, raw, contributions: [], degradedProviders: [], projection: createRegisteredReadProjection(adapter.reader, raw, { identity, revision }) };
  };
  const previous = snapshot("old", "r1"), current = snapshot("new", "r2");
  let latest = current, revoked = false, disposed = false, clocks = 0, releases = 0, queued;
  const guard = () => { if (disposed) throw createWeaverError("DISPOSED", "disposed"); clocks++; if (revoked) throw createWeaverError("FORBIDDEN", "revoked"); };
  const query = (relative) => {
    assert.deepEqual(relative, ["flag"]);
    guard(); const access = (evidence) => { guard(); return !evidence.sensitive; };
    latest.projection.get("/alpha/flag", access);
    return { path: "/alpha/flag", access, guard, snapshot: latest };
  };
  const events = { subscribe(_selection, _path, callback) { queued = callback; return () => { releases++; }; }, clear() {} };
  const subscriptions = createReaderSubscriptions(events, selection, query), delivered = [];
  const relative = ["flag"], unsubscribe = subscriptions.subscribe(relative, (change) => delivered.push(change));
  relative[0] = "different";
   const change = { selection, previous, current, cause: "mutation", reloadBehavior: "hot" };
  queued(change);
  assert.deepEqual(delivered[0].previous, { state: "value", value: "old" });
  assert.deepEqual(delivered[0].current, { state: "value", value: "new" });
  assert.equal(delivered[0].revision, "r2");
  revoked = true; queued(change); assert.equal(delivered.length, 1);
  revoked = false;
  schema.schema.properties.flag["x-weaver"] = { sensitive: true }; adapter.prepare(schema).publish();
  latest = snapshot("SECRET", "r3"); queued(change); assert.equal(delivered.length, 1);
  disposed = true; const before = clocks; queued(change); assert.equal(clocks, before);
  unsubscribe(); unsubscribe(); subscriptions.clear(); queued(change);
  assert.equal(releases, 1); assert.equal(delivered.length, 1);
  } finally { unregister(); }
});

test("per-query host decisions prune aggregates, redact inspect and omit entire restricted arrays", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { open: "public", hidden: "SECRET", admin: "ADMIN", list: [1, 2], denied: "DENIED" } });
  const input = options([provider], { schemas: [registration("east", "alpha", { type: "object", properties: {
    open: { type: "string" }, hidden: { type: "string", "x-weaver": { sensitive: true } },
    admin: { type: "string", "x-weaver": { visibility: "admin" } }, denied: { type: "string" },
    list: { type: "array", items: [{ type: "number" }, { type: "number", "x-weaver": { sensitive: true } }] },
  } })] });
  let deny = true;
  const setup = await hosted(input, { hostAuthority: {
    authorizeReadSync: (_actor, request) => deny && request.path === "/alpha/denied" ? "denied" : "allowed",
    authorizeWrite: async () => "denied",
  } });
  try {
    const claims = principal(input); claims.roles = [];
    const reader = setup.controller.forIdentity(setup.controller.mint(claims), { identity: input.identity, namespace: "/alpha" });
    assert.deepEqual(reader.get(), { open: "public" });
    assert.throws(() => reader.get(["list"], { defaultValue: [] }), { code: "FORBIDDEN" });
    assert.deepEqual(reader.inspect(["list"]).effective, { state: "redacted" });
    assert.deepEqual(reader.inspect(["denied"]).effective, { state: "redacted" });
    deny = false;
    assert.equal(reader.get().denied, "DENIED");
    const privileged = principal(input); privileged.grants[0].sensitive = true;
    const elevated = setup.controller.forIdentity(setup.controller.mint(privileged), { identity: input.identity, namespace: "/alpha" });
    assert.deepEqual(elevated.get(["list"]), [1, 2]);
    assert.equal(elevated.get(["hidden"]), "SECRET");
    assert.equal(elevated.get(["admin"]), "ADMIN");
    assert.equal(elevated.validate().validation.valid, true);
    assert.equal(provider.loads, 1);
  } finally { await setup.root.dispose(); }
});

async function queuedAggregateFixture(viewId) {
  const { validateFactory } = await import("../src/factory-validation.ts");
  const { loadContributions } = await import("../src/hydration.ts");
  const { stageIdentity } = await import("../src/identity-snapshots.ts");
  const { identityKey } = await import("../src/layer-stack.ts");
  const { createOperationQueue } = await import("../src/operation-queue.ts");
  const { createHostAuthority } = await import("../src/authority/host-authority.ts");
  const { selectedSnapshot, stageViews } = await import("../src/view-snapshots.ts");
  const settings = { open: { type: "string" }, flag: { type: "string" } };
  const schema = registration("east", "alpha", { type: "object", properties: {
    ...settings, instances: { type: "object", additionalProperties: { type: "object", properties: structuredClone(settings) } },
  } });
  const provider = new MemoryProvider("p", "base", {}), input = options([provider], { schemas: [schema] });
  let queued, denyFlag = false;
  const host = readonlyHost(input);
  host.hostAuthority.authorizeReadSync = (_actor, request) => denyFlag && request.path === "/alpha/flag" ? "denied" : "allowed";
  const factory = validateFactory(input, host), identity = factory.options.identity;
  const loaded = await loadContributions(factory.selected, identity), key = identityKey(identity);
  const state = { factory, ready: new Map(), views: new Map(), fixed: loaded, generation: 0,
    incarnation: "queued-test:", disposed: false, queue: createOperationQueue(),
     events: { subscribe(_selection, _path, callback) { queued = callback; return () => {}; }, publish() {} } };
  const selection = { identity, namespace: "/alpha", ...(viewId === undefined ? {} : { viewId }) };
  const install = (open, flag, revision) => {
    const value = { open, flag };
    const entries = { alpha: viewId === undefined ? value : { open: "base", instances: { [viewId]: value } } };
    const contributions = loaded.map((item) => ({ ...item, layer: { ...item.layer, entries } }));
    const snapshot = stageIdentity(identity, revision, contributions, factory.registry, [0], undefined, factory.adapter.revision);
    state.ready.set(key, snapshot);
    state.views = stageViews(state.views, state.ready, factory.registry, false);
    return snapshot;
  };
  install("first-public", "OLD_SECRET", "r1");
  const { controller } = createHostAuthority(state, async (_identity, guard) => guard());
  const claims = principal(input); claims.grants[0].views = viewId === undefined ? [] : [viewId];
  const reader = controller.forIdentity(controller.mint(claims), selection);
  await reader.prepare();
  const delivered = [], unsubscribe = reader.onChange([], (event) => delivered.push(event));
  const current = () => selectedSnapshot(state, selection);
   const deliver = (previous, next) => queued({ selection, previous, current: next, cause: "mutation", reloadBehavior: "hot" });
  return { state, schema, reader, install, current, delivered, deliver, unsubscribe, deny: (value) => { denyFlag = value; } };
}

for (const viewId of [undefined, "one"]) test(`private queued aggregate suppresses stale ${viewId ? "physical view" : "base"} schema, not data revisions`, async () => {
  const { register } = await import("tsx/esm/api"), unregister = register();
  let fixture;
  try {
    const { stageSchemaPublication } = await import("../src/authority/schema-publication.ts");
    fixture = await queuedAggregateFixture(viewId);
    const { state, schema, reader, install, current, delivered, deliver } = fixture;
    const previous = current();
    install("second-public", "NEW_SECRET", "r2"); const next = current();
    install("latest-public", "LATEST_SECRET", "r3");
    deliver(previous, next);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].previous.value, { open: "first-public", flag: "OLD_SECRET" });
    assert.deepEqual(delivered[0].current.value, { open: "second-public", flag: "NEW_SECRET" });
    assert.equal(delivered[0].revision, "r2");
    fixture.deny(true); deliver(previous, next);
    assert.deepEqual(delivered[1].previous.value, { open: "first-public" });
    assert.deepEqual(delivered[1].current.value, { open: "second-public" });
    fixture.deny(false);
    const properties = viewId ? schema.schema.properties.instances.additionalProperties.properties : schema.schema.properties;
    properties.flag["x-weaver"] = { sensitive: true };
    const revision = state.factory.adapter.revision;
    const plan = stageSchemaPublication(state, state.factory.adapter.prepare(schema));
    assert.equal(state.factory.adapter.revision, revision);
    assert.equal(current().registryRevision, revision);
    plan.publish();
    assert.equal(current().registryRevision, revision + 1);
    assert.equal(current().registryRevision, state.factory.adapter.revision);
    assert.deepEqual(reader.get(), { open: "latest-public" });
    deliver(previous, next); deliver(next, current()); deliver(current(), next);
    assert.equal(delivered.length, 5);
    for (const event of delivered.slice(2)) {
      assert.equal(event.kind, "invalidation");
      assert.equal(event.reason, "stale");
      assert.equal("previous" in event, false);
      assert.equal("current" in event, false);
    }
    const freshPrevious = current(); install("fresh-public", "FRESH_SECRET", "r5"); const freshNext = current();
    install("newest-public", "NEWEST_SECRET", "r6");
    deliver(freshPrevious, freshNext);
    assert.equal(delivered.length, 6);
    assert.deepEqual(delivered[5].previous.value, { open: "latest-public" });
    assert.deepEqual(delivered[5].current.value, { open: "fresh-public" });
    assert.equal(delivered[5].revision, "r5");
    assert.doesNotMatch(JSON.stringify(delivered.slice(1)), /SECRET/);
  } finally { fixture?.unsubscribe(); fixture?.reader.dispose(); unregister(); }
});
