import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writable, WritableMemory, writableOptions } from "./fixtures/writable-memory.mjs";
import { deferred } from "./fixtures/memory.mjs";

test("opt-in borrowed subscription ignores hint payload, publishes validated reload and owns only unsubscribe", async () => {
  class Watched extends WritableMemory {
    subscriptions = 0; releases = 0; refreshes = 0;
    onExternalChange(callback) { this.subscriptions++; this.notify = callback; return () => { this.releases++; }; }
    async refresh() { this.refreshes++; }
  }
  const provider = new Watched(), input = writableOptions([provider]);
  input.providers[0].watch = true;
  const { root, reader } = await writable({ provider, input });
  try {
    let delivered;
    const event = new Promise(resolve => { delivered = resolve; });
    reader.onChange(["flag"], delivered);
    let getters = 0;
    provider.entries.alpha.flag = "watched";
    provider.notify({ get value() { getters++; throw Error("untrusted"); } });
    const change = await event;
    assert.equal(change.cause, "external"); assert.equal(change.current.value, "watched");
    assert.equal(getters, 0); assert.equal(provider.refreshes, 0);
    assert.equal(provider.subscriptions, 1);
  } finally { await root.dispose(); }
  assert.equal(provider.releases, 1);
  const loads = provider.loads; provider.notify([]); await Promise.resolve();
  assert.equal(provider.loads, loads);
});

test("watch coalesces queued bursts and retains one hint arriving during a read", async () => {
  const entered = deferred(), release = deferred();
  class Watched extends WritableMemory {
    onExternalChange(callback) { this.notify = callback; return () => {}; }
    async load() {
      const result = await super.load();
      if (this.loads === 2) { entered.resolve(); await release.promise; }
      return result;
    }
  }
  const provider = new Watched(), input = writableOptions([provider]); input.providers[0].watch = true;
  const { root, reader } = await writable({ provider, input });
  try {
    let done; const settled = new Promise(resolve => { done = resolve; });
    const events = []; reader.onChange(["flag"], event => { events.push(event); if (event.current.value === "second") done(); });
    provider.entries.alpha.flag = "first";
    provider.notify([]); provider.notify([]); provider.notify([]);
    await entered.promise;
    provider.entries.alpha.flag = "second"; provider.notify([]); provider.notify([]);
    release.resolve(); await settled;
    assert.equal(provider.loads, 3);
    assert.deepEqual(events.map(event => event.current.value), ["first", "second"]);
  } finally { release.resolve(); await root.dispose(); }
});

test("synchronous setup hints wait for activation; later subscription failure releases prior borrowed subscriptions", async () => {
  const first = new WritableMemory(), second = new WritableMemory("second", "second", {});
  let releases = 0;
  first.onExternalChange = callback => { callback([]); return () => { releases++; }; };
  second.onExternalChange = () => { throw Error("SECRET"); };
  const input = writableOptions([first, second]); input.providers.forEach(binding => { binding.watch = true; });
  await assert.rejects(writable({ provider: first, input }), error => error.code === "VALIDATION_ERROR" && !JSON.stringify(error).includes("SECRET"));
  assert.equal(releases, 1); assert.equal(first.loads, 1); assert.equal(second.loads, 1);
});

test("watch is off by default and unsupported opt-in fails before reads", async () => {
  const provider = new WritableMemory();
  Object.defineProperty(provider, "onExternalChange", { get() { throw Error("must not inspect"); } });
  const setup = await writable({ provider }); await setup.root.dispose();
  const missing = new WritableMemory(), input = writableOptions([missing]); input.providers[0].watch = true;
  await assert.rejects(writable({ provider: missing, input }), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(missing.loads, 0);
});

for (const [name, modes] of [
  ["rejected promises", ["async-rejection", "delayed-rejection"]],
  ["malformed thenables and other returns", ["thenable-rejection", "throwing-then", "never-settles", "resolved-function", "primitive", "sync-throw"]],
]) test(`invalid watch ${name} reject statically without escaping rejection or losing cleanup`, () => {
  for (const mode of modes) {
    const child = spawnSync(process.execPath, ["--unhandled-rejections=strict",
      fileURLToPath(new URL("./fixtures/invalid-watch-child.mjs", import.meta.url)), mode],
    { encoding: "utf8", timeout: 10000 });
    assert.equal(child.error, undefined, `${mode}: ${child.error?.message}`);
    assert.equal(child.signal, null, mode);
    assert.equal(child.status, 0, `${mode}: ${child.stdout}\n${child.stderr}`);
    assert.equal(child.stderr, "", mode);
    assert.doesNotMatch(child.stdout, /SECRET/);
    const report = JSON.parse(child.stdout);
    assert.equal(report.code, "VALIDATION_ERROR");
    assert.equal(report.message, "Provider watch did not return an unsubscribe function");
    assert.deepEqual(report.released, [1, 1, 1]);
    assert.deepEqual(report.closed, [0, 0, 1, 1]);
    assert.equal(report.ready, 0);
  }
});
