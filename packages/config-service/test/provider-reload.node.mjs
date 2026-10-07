import assert from "node:assert/strict";
import { test } from "node:test";
import { writable, WritableMemory, writableOptions } from "./fixtures/writable-memory.mjs";
import { hosted, principal } from "./fixtures/authority.mjs";

test("explicit captured refresh preserves receiver and reload retains last good on failure", async () => {
  class Refreshable extends WritableMemory {
    refreshes = 0;
    async refresh() { this.refreshes++; }
  }
  const provider = new Refreshable();
  const { root, reader } = await writable({ provider });
  const changes = [];
  try {
    reader.onChange(["flag"], event => changes.push(event));
    assert.equal((await root.reloadProvider("unknown")).error.code, "VALIDATION_ERROR");
    assert.equal(provider.refreshes, 0);
    provider.entries.alpha.flag = "external";
    assert.equal((await root.reloadProvider(provider.id)).ok, true);
    assert.equal(provider.refreshes, 1); assert.equal(reader.get(["flag"]), "external");
    assert.equal(changes.length, 1); assert.equal(changes[0].cause, "reload");
    const revision = reader.revision;
    provider.entries.alpha.flag = 42;
    assert.equal((await root.reloadProvider(provider.id)).ok, false);
    assert.equal(reader.get(["flag"]), "external"); assert.equal(reader.revision, revision);
    assert.equal(root.mode, "degraded");
    provider.entries.alpha.flag = "recovered";
    assert.equal((await root.reloadProvider(provider.id)).ok, true);
    assert.equal(root.mode, "live"); assert.equal(changes.length, 2);
  } finally { await root.dispose(); }
  assert.equal((await root.reloadProvider(provider.id)).error.code, "DISPOSED");
});

test("contextual fixed reads remain identity-specific; reload validates every identity before publishing", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const calls = [], a = [{ scopeId: "tenant", value: "a" }], b = [{ scopeId: "tenant", value: "b" }];
  let generation = 0, failB = false;
  input.providers[0].operation = { kind: "read", async read({ identity }) {
    const key = identity.scopePath[0]?.value ?? "root";
    calls.push(key);
    if (failB && key === "b") throw Error("SECRET");
    return { entries: { alpha: { flag: `${key}:${generation}` } } };
  } };
  const { root, controller } = await hosted(input);
  const claims = principal(input);
  claims.grants.push(...[a, b].map(scopePath => ({ ...claims.grants[0], identity: { ...input.identity, scopePath } })));
  const token = controller.mint(claims);
  const readers = [[], a, b].map(scopePath => controller.forIdentity(token, { identity: { ...input.identity, scopePath }, namespace: "/alpha" }));
  try {
    await readers[1].prepare(); await readers[2].prepare();
    assert.deepEqual(readers.map(reader => reader.get(["flag"])), ["root:0", "a:0", "b:0"]);
    assert.deepEqual(calls, ["root", "a", "b"]);
    const revisions = readers.map(reader => reader.revision);
    generation = 1; failB = true;
    const failure = await root.reloadProvider(provider.id);
    assert.equal(failure.ok, false); assert.doesNotMatch(JSON.stringify(failure), /SECRET/);
    assert.deepEqual(readers.map(reader => reader.revision), revisions);
    assert.deepEqual(readers.map(reader => reader.get(["flag"])), ["root:0", "a:0", "b:0"]);
    failB = false; assert.equal((await root.reloadProvider(provider.id)).ok, true);
    assert.deepEqual(readers.map(reader => reader.get(["flag"])), ["root:1", "a:1", "b:1"]);
    assert.equal(new Set(readers.map(reader => reader.revision)).size, 1);
  } finally { await root.dispose(); }
});

test("successful reload repairs only its failed bootstrap contribution", async () => {
  const first = new WritableMemory(), second = new WritableMemory("second", "second", {});
  let broken = true;
  const load = first.load;
  first.load = async function () { if (broken) throw Error("initial"); return load.call(this); };
  second.load = async () => { throw Error("unrelated"); };
  const input = writableOptions([first, second]); input.failureMode = "allow-degraded";
  const { root, controller } = await hosted(input);
  const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
  try {
    assert.deepEqual(root.degradedProviders, [first.id, second.id]);
    assert.equal(reader.get(["flag"]), undefined);
    broken = false; assert.equal((await root.reloadProvider(first.id)).ok, true);
    assert.equal(reader.get(["flag"]), "before");
    assert.deepEqual(root.degradedProviders, [second.id]);
  } finally { await root.dispose(); }
});

test("externally missing owned registry fences payload and subsequent reload before IO", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const { root, reader } = await writable({ provider, input,
    host: { registry: { storage: { kind: "provider", providerId: provider.id } } } });
  try {
    delete provider.entries._weaver;
    assert.equal((await root.reloadProvider(provider.id)).error.code, "SERVER_DEGRADED");
    const loads = provider.loads;
    assert.throws(() => reader.get(), { code: "SERVER_DEGRADED" });
    assert.equal((await root.reloadProvider(provider.id)).error.code, "SERVER_DEGRADED");
    assert.equal(provider.loads, loads);
    assert.equal((await root.flush()).error.code, "SERVER_DEGRADED");
    assert.equal((await root.acknowledgeRestart(root.restartState.revision)).error.code, "SERVER_DEGRADED");
  } finally { await root.dispose(); }
});
