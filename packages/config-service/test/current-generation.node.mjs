import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { test } from "node:test";
import { hostedReader, principal, readonlyHost } from "./fixtures/authority.mjs";
import { deferred, MemoryProvider, options, scopeOptions } from "./fixtures/memory.mjs";
import { tooling } from "./fixtures/packed-consumer.mjs";

// Bundle private modules into a test-local fixture, never a production export or
// a mutation hook on the public root. Package dependencies remain the real ones.
const { build } = tooling("esbuild");
const compiled = await build({
  stdin: {
    contents: `export { createHostAuthority } from "./authority/host-authority";
      export { stageIdentity } from "./identity-snapshots";
      export { currentIdentity } from "./identity-state";
      export { identityKey } from "./layer-stack";
      export { createOperationQueue } from "./operation-queue";
      export { validateFactory } from "./factory-validation";
      export { loadContributions } from "./hydration";
      export { createServiceEvents } from "./service-events";`,
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
});
const fixture = { exports: {} };
runInThisContext(`(function(require, module, exports) {${compiled.outputFiles[0].text}\n})`)(createRequire(import.meta.url), fixture, fixture.exports);
const { createHostAuthority, stageIdentity, currentIdentity, identityKey,
  createOperationQueue, validateFactory, loadContributions, createServiceEvents } = fixture.exports;

test("private current identity lookup keeps value, inspection and revision on the published generation", async () => {
  const provider = new MemoryProvider("base", "base", { alpha: { flag: "before" } });
  const input = options([provider]);
  const factory = validateFactory(input, readonlyHost(input));
  const identity = factory.options.identity;
  const original = await loadContributions(factory.selected, identity);
  const first = stageIdentity(identity, "original", original, factory.registry, [0], undefined, factory.adapter.revision);
  const state = { factory, ready: new Map([[identityKey(identity), first]]), views: new Map(),
    disposed: false, events: createServiceEvents() };
  const { controller } = createHostAuthority(state, async () => { throw Error("ready reader must not hydrate"); });
  const reader = controller.forIdentity(controller.mint(principal(input)), { identity, namespace: "/alpha" });
  provider.entries = { alpha: { flag: "after" } };
  const loaded = await loadContributions(factory.selected, identity);
  const next = stageIdentity(identity, "successor", loaded, factory.registry, [0], undefined, factory.adapter.revision);
  assert.equal(reader.get(["flag"]), "before");
  assert.equal(reader.revision, first.revision);
  state.ready.set(identityKey(identity), next);
  assert.equal(currentIdentity(state, identity), next);
  assert.equal(reader.get(["flag"]), "after");
  assert.equal(reader.inspect(["flag"]).effective.value, "after");
  assert.equal(reader.inspect(["flag"]).revision, reader.revision);
  assert.equal(reader.revision, next.revision);
  assert.deepEqual(reader.selection.identity, identity);
  assert.notEqual(reader.selection.identity, identity);
  assert.equal(first.projection.get("/alpha/flag"), "before");
  assert.equal(first.contributions[0], original[0]);
  assert.equal(next.contributions[0], loaded[0]);
  assert.ok(Object.isFrozen(next.contributions));
  assert.equal(provider.loads, 2);
  state.disposed = true;
  assert.throws(() => reader.get(["flag"]), { code: "DISPOSED" });
  assert.throws(() => reader.revision, { code: "DISPOSED" });
});

test("one typed-result queue is FIFO, retains rejection, and settles all accepted work", async () => {
  const queue = createOperationQueue(), gate = deferred(), calls = [];
  const failure = new Error("first operation");
  const first = queue.enqueue(async () => { calls.push("first"); await gate.promise; throw failure; });
  const rejected = assert.rejects(first, (error) => error === failure);
  const second = queue.enqueue(() => { calls.push("second"); return 42; });
  let settled = false;
  const settlement = queue.settled().then(() => { settled = true; });
  await Promise.resolve(); assert.deepEqual(calls, ["first"]); assert.equal(settled, false);
  gate.resolve(); await rejected;
  assert.equal(await second, 42); await settlement;
  assert.deepEqual(calls, ["first", "second"]); assert.equal(settled, true);
  assert.equal(await queue.enqueue(() => "third"), "third");
});

test("reader preparation advances only a cold identity, never the original selected generation", async () => {
  const setup = scopeOptions();
  const { root, reader } = await hostedReader(setup.input);
  try {
    const identity = reader.selection.identity, revision = reader.revision;
    const before = reader.inspect(["flag"]);
    const first = reader.withScope(setup.path1), second = reader.withScope(setup.path2);
    await first.prepare();
    await second.prepare();
    await first.prepare();
    assert.equal(reader.selection.identity, identity); assert.equal(reader.revision, revision);
    assert.deepEqual(reader.inspect(["flag"]), before);
    assert.equal(first.get(["flag"]), "one");
    assert.equal(second.get(["flag"]), "two");
    for (const provider of [setup.base, setup.first, setup.second, setup.last]) {
      assert.equal(provider.loads, 1);
      assert.equal(provider.writes + provider.removes + provider.flushes, 0);
    }
  } finally { await root.dispose(); }
});
