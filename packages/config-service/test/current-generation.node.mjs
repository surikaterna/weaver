import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { deferred, MemoryProvider, options, scopeOptions } from "./fixtures/memory.mjs";
import { tooling } from "./fixtures/packed-consumer.mjs";

// Bundle private modules into a test-local fixture, never a production export or
// a mutation hook on the public root. Package dependencies remain the real ones.
const { build } = tooling("esbuild");
const compiled = await build({
  stdin: {
    contents: `export { createSnapshotReader } from "./snapshot-reader";
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
const { createSnapshotReader, stageIdentity, currentIdentity, identityKey,
  createOperationQueue, validateFactory, loadContributions, createServiceEvents } = fixture.exports;

test("private current identity lookup keeps value, inspection and revision on the published generation", async () => {
  const provider = new MemoryProvider("base", "base", { alpha: { flag: "before" } });
  const factory = validateFactory(options([provider]));
  const identity = factory.options.identity;
  const original = await loadContributions(factory.selected, identity);
  const first = stageIdentity(identity, "original", original, factory.registry, [0], undefined);
  const state = { factory, ready: new Map([[identityKey(identity), first]]), disposed: false };
  const reader = createSnapshotReader(() => currentIdentity(state, identity), () => {}, createServiceEvents());
  provider.entries = { alpha: { flag: "after" } };
  const loaded = await loadContributions(factory.selected, identity);
  const next = stageIdentity(identity, "successor", loaded, factory.registry, [0], undefined);
  assert.equal(reader.get("/alpha/flag"), "before");
  assert.equal(reader.revision, first.revision);
  state.ready.set(identityKey(identity), next);
  assert.equal(reader.get("/alpha/flag"), "after");
  assert.equal(reader.inspect("/alpha/flag").effective.value, "after");
  assert.equal(reader.inspect("/alpha/flag").revision, reader.revision);
  assert.equal(reader.revision, next.revision);
  assert.equal(reader.identity, identity);
  assert.equal(first.projection.get("/alpha/flag"), "before");
  assert.equal(first.contributions[0], original[0]);
  assert.equal(next.contributions[0], loaded[0]);
  assert.ok(Object.isFrozen(next.contributions));
  assert.equal(provider.loads, 2);
  state.disposed = true;
  assert.throws(() => reader.get("/alpha/flag"), { code: "DISPOSED" });
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

test("public preload advances only a cold identity, never the original root generation", async () => {
  const setup = scopeOptions();
  const root = await createConfigurationService(setup.input);
  try {
    const identity = root.identity, revision = root.revision;
    const before = root.inspect("/alpha/flag");
    await root.preloadScope(setup.path1);
    await root.preloadScope(setup.path2);
    await root.preloadScope(setup.path1);
    assert.equal(root.identity, identity); assert.equal(root.revision, revision);
    assert.deepEqual(root.inspect("/alpha/flag"), before);
    assert.equal(root.getForScope("/alpha/flag", setup.path1), "one");
    assert.equal(root.getForScope("/alpha/flag", setup.path2), "two");
    for (const provider of [setup.base, setup.first, setup.second, setup.last]) {
      assert.equal(provider.loads, 1);
      assert.equal(provider.writes + provider.removes + provider.flushes, 0);
    }
  } finally { await root.dispose(); }
});
