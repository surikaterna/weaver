import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { WeaverErrorInstance } from "@weaver-conf/config-types";
import { createFileSystemStorageProvider } from "../dist/index.js";

const mapped = "tenant:日本/blue";
const invalid = ["SENTINEL-secret {{{", "", " \n\t", "null", "[]", "42", '"SENTINEL-secret"'];
const messages = {
  VALIDATION_ERROR: "Configuration file contains invalid configuration data",
  SERVER_DEGRADED: "Configuration file could not be read",
};
function rejects(code, path) {
  return (error) => {
    assert.ok(error instanceof WeaverErrorInstance);
    assert.equal(error.code, code);
    assert.equal(error.message, messages[code]);
    assert.equal(error.cause, undefined);
    assert.equal(error.details, undefined);
    assert.ok(!JSON.stringify(error).includes(path));
    assert.ok(!JSON.stringify(error).includes("SENTINEL-secret"));
    return true;
  };
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "weaver-read-errors-"));
  const filePath = join(directory, "config.json");
  const provider = createFileSystemStorageProvider({
    id: "disk", layer: "base", filePath, writable: true, watchDebounceMs: 10,
  });
  const io = trackFileIO();
  try { await run({ directory, filePath, provider, io }); }
  finally {
    provider.dispose();
    try { await io.settle(); await rm(directory, { recursive: true, force: true }); }
    finally { io.close(); }
  }
}
function selected(filePath, provider, dialect) {
  if (dialect === "load") return { path: filePath, load: () => provider.load() };
  const layer = dialect === "default-layer" ? "base" : mapped;
  return {
    path: layer === "base" ? filePath : `${filePath}.${encodeURIComponent(layer)}.json`,
    load: () => provider.loadLayer(layer),
  };
}

for (const dialect of ["load", "default-layer", "mapped-layer"]) {
  test(`${dialect}: missing, empty object, invalid data and real EISDIR are distinct`, async () => {
    await fixture(async ({ filePath, provider }) => {
      const target = selected(filePath, provider, dialect);
      assert.deepEqual((await target.load()).entries, {});
      await writeFile(target.path, "{}");
      assert.deepEqual((await target.load()).entries, {});
      for (const contents of invalid) {
        await writeFile(target.path, contents);
        await assert.rejects(target.load(), rejects("VALIDATION_ERROR", target.path));
      }
      await rm(target.path);
      await mkdir(target.path);
      await assert.rejects(target.load(), rejects("SERVER_DEGRADED", target.path));
    });
  });
  test(`${dialect}: overlay failure rejects the whole load`, async () => {
    await fixture(async ({ directory, filePath }) => {
      const overlay = join(directory, "overlay.json");
      const provider = createFileSystemStorageProvider({ id: "disk", layer: "base", filePath, environmentOverlayPath: overlay });
      const target = selected(filePath, provider, dialect);
      try {
        assert.deepEqual((await target.load()).entries, {});
        await writeFile(overlay, '{"nested":{"overlay":2}}');
        assert.deepEqual((await target.load()).entries, { nested: { overlay: 2 } });
        await writeFile(target.path, '{"nested":{"base":1}}');
        assert.deepEqual((await target.load()).entries, { nested: { base: 1, overlay: 2 } });
        await rm(overlay);
        assert.deepEqual((await target.load()).entries, { nested: { base: 1 } });
        for (const contents of invalid) {
          await writeFile(overlay, contents);
          await assert.rejects(target.load(), rejects("VALIDATION_ERROR", overlay));
        }
        await rm(overlay); await mkdir(overlay);
        await assert.rejects(target.load(), rejects("SERVER_DEGRADED", overlay));
        await rm(overlay, { recursive: true }); await writeFile(overlay, "{}");
        await writeFile(target.path, "SENTINEL-secret {{{");
        await assert.rejects(target.load(), rejects("VALIDATION_ERROR", target.path));
      } finally { provider.dispose(); }
    });
  });
}

test("all write/remove dialects preserve corrupt bytes without creating temporary files", async () => {
  await fixture(async ({ directory, filePath, provider }) => {
    const mappedPath = `${filePath}.${encodeURIComponent(mapped)}.json`;
    const operations = [
      [filePath, () => provider.write("nested.flag", true)],
      [filePath, () => provider.remove("nested.flag")],
      [filePath, () => provider.writeLayer("base", "nested.flag", true)],
      [filePath, () => provider.removeLayer("base", "nested.flag")],
      [mappedPath, () => provider.writeLayer(mapped, "nested.flag", true)],
      [mappedPath, () => provider.removeLayer(mapped, "nested.flag")],
    ];
    for (const [path, mutate] of operations) {
      await writeFile(path, "SENTINEL-secret {{{");
      const before = await readdir(directory);
      await assert.rejects(mutate(), rejects("VALIDATION_ERROR", path));
      assert.equal(await readFile(path, "utf8"), "SENTINEL-secret {{{");
      assert.deepEqual(await readdir(directory), before);
      await rm(path); await mkdir(path);
      await assert.rejects(mutate(), rejects("SERVER_DEGRADED", path));
      assert.deepEqual(await readdir(path), []);
      await rm(path, { recursive: true });
    }
  });
});
test("missing ordinary/mapped targets still initialize nested data and remove normally", async () => {
  await fixture(async ({ directory }) => {
    const filePath = join(directory, "missing-parent", "new.json");
    const provider = createFileSystemStorageProvider({ id: "new", layer: "base", filePath, writable: true });
    try {
      assert.equal((await provider.remove("absent")).success, true);
      assert.equal((await provider.write("nested.flag", null)).success, true);
      assert.deepEqual((await provider.load()).entries, { nested: { flag: null } });
      assert.equal((await provider.remove("nested.flag")).success, true);
      assert.deepEqual((await provider.load()).entries, { nested: {} });
      assert.equal((await provider.removeLayer(mapped, "absent")).success, true);
      assert.equal((await provider.writeLayer(mapped, "nested.flag", true)).success, true);
      assert.deepEqual((await provider.loadLayer(mapped)).entries, { nested: { flag: true } });
      assert.equal((await provider.removeLayer(mapped, "nested.flag")).success, true);
      assert.deepEqual((await provider.loadLayer(mapped)).entries, { nested: {} });
    } finally { provider.dispose(); }
  });
});

function resourceCount(name) {
  return process.getActiveResourcesInfo().filter((value) => value === name).length;
}
function isFileRequest(type) {
  // Node 26's UTF-8 readFile uses FSREQCALLBACK, not the older FSREQPROMISE path.
  return type === "FSREQPROMISE" || type === "FSREQCALLBACK" || type === "FILEHANDLECLOSEREQ";
}
function trackFileIO() {
  const pending = new Set();
  const hook = createHook({
    init(id, type) { if (isFileRequest(type)) pending.add(id); },
    destroy(id) { pending.delete(id); },
  }).enable();
  return {
    pending: () => pending.size,
    settle: () => until(() => pending.size === 0, "filesystem requests settled"),
    close: () => hook.disable(),
  };
}
async function until(predicate, description) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, description);
    await sleep(5);
  }
}
function observer(provider) {
  const received = [];
  const unsubscribe = provider.onExternalChange((changes) => received.push(changes));
  return { received, unsubscribe };
}
async function change(filePath, observed, entries) {
  const before = observed.received.length;
  await writeFile(filePath, JSON.stringify(entries));
  await until(() => observed.received.length > before, "filesystem change callback");
  return observed.received.at(-1);
}
for (const failure of ["invalid", "unreadable"]) {
  test(`${failure} initial subscription owns no watcher; repair and explicit re-subscription works`, async () => {
    await fixture(async ({ filePath, provider, io }) => {
      if (failure === "invalid") await writeFile(filePath, "SENTINEL-secret {{{");
      else await mkdir(filePath);
      await io.settle();
      const watchers = resourceCount("FSEventWrap");
      const failed = observer(provider);
      try {
        // Observe completion of actual filesystem work, not an assumed startup delay.
        assert.ok(io.pending() > 0, "initial read observed before settlement");
        await io.settle();
        assert.equal(resourceCount("FSEventWrap"), watchers);
        assert.deepEqual(failed.received, []);
      } finally { failed.unsubscribe(); }
      await rm(filePath, { recursive: true });
      await writeFile(filePath, '{"flag":1}');
      const repaired = observer(provider);
      try {
        await until(() => resourceCount("FSEventWrap") > watchers, "watcher acquisition");
        assert.deepEqual(await change(filePath, repaired, { flag: 2 }), [{ key: "flag", oldValue: 1, newValue: 2 }]);
      } finally { repaired.unsubscribe(); }
    });
  });
}
test("active watcher keeps last good snapshot across invalid data, then recovers without fake deletions", async () => {
  await fixture(async ({ filePath, provider }) => {
    await writeFile(filePath, '{"flag":1,"retained":"yes"}');
    const watchers = resourceCount("FSEventWrap");
    const observed = observer(provider);
    try {
      await until(() => resourceCount("FSEventWrap") > watchers, "watcher acquisition");
      await change(filePath, observed, { flag: 2, retained: "yes" });
      const baseline = observed.received.length;
      await writeFile(filePath, "SENTINEL-secret {{{");
      // A bounded negative window covers debounce and failed IO; no mutation retry.
      await sleep(100);
      assert.equal(observed.received.length, baseline);
      assert.deepEqual(await change(filePath, observed, { flag: 3, retained: "yes" }), [{ key: "flag", oldValue: 2, newValue: 3 }]);
      const repaired = observed.received.length;
      await rm(filePath); await mkdir(filePath); await sleep(100);
      assert.equal(observed.received.length, repaired);
      await rm(filePath, { recursive: true });
      assert.deepEqual(await change(filePath, observed, { flag: 4, retained: "yes" }), [{ key: "flag", oldValue: 3, newValue: 4 }]);
      observed.unsubscribe(); provider.dispose();
      const final = observed.received.length;
      await writeFile(filePath, '{"flag":5}'); await sleep(100);
      assert.equal(observed.received.length, final);
    } finally { observed.unsubscribe(); }
  });
});

async function rapidSubscription(provider, filePath, before, io) {
  const retired = [], current = [];
  let acquired = 0;
  const hook = createHook({ init(_id, type) { if (type === "FSEVENTWRAP") acquired++; } });
  hook.enable();
  const stale = provider.onExternalChange((changes) => retired.push(changes));
  assert.ok(io.pending() > 0, "unsubscribe while initial read is unsettled");
  stale();
  const stop = provider.onExternalChange((changes) => current.push(changes));
  try {
    await io.settle();
    const afterResubscribe = resourceCount("FSEventWrap") - before;
    console.log(JSON.stringify({ afterResubscribe, acquired }));
    assert.equal(afterResubscribe, 1);
    assert.equal(acquired, 1);
    assert.deepEqual(retired, []);
    assert.deepEqual(current, []);
    assert.deepEqual(await change(filePath, { received: current }, { flag: "current" }), [{ key: "flag", oldValue: "initial", newValue: "current" }]);
    assert.deepEqual(retired, []);
  } finally { hook.disable(); stop(); }
}
async function staleUnsubscribe(provider, filePath, before, io) {
  const retired = observer(provider);
  await until(() => resourceCount("FSEventWrap") > before, "first watcher ready");
  const current = observer(provider);
  try {
    await io.settle();
    retired.unsubscribe(); retired.unsubscribe();
    assert.equal(resourceCount("FSEventWrap") - before, 1);
    assert.deepEqual(await change(filePath, current, { flag: "current" }), [{ key: "flag", oldValue: "initial", newValue: "current" }]);
    assert.deepEqual(retired.received, []);
  } finally { current.unsubscribe(); }
}
async function malformedReplacement(provider, filePath, before, io) {
  writeFileSync(filePath, "invalid JSON {");
  await assert.rejects(provider.load(), { code: "VALIDATION_ERROR" });
  let request, retired, current;
  const hook = createHook({
    init(id, type) { if (request === undefined && isFileRequest(type)) request = id; },
    before(id) {
      if (id !== request) return;
      hook.disable();
      // Open (Node 24) or whole UTF-8 read (Node 26) completed, but its
      // promise continuation has not run. Preserve the corrupt inode/result.
      queueMicrotask(() => {
        retired.unsubscribe();
        renameSync(filePath, `${filePath}.retired`);
        writeFileSync(filePath, '{"flag":"repaired"}');
        current = observer(provider);
      });
    },
  });
  try {
    hook.enable();
    retired = observer(provider);
    await until(() => current !== undefined, "repair before old read continuation");
    await io.settle();
    retired.unsubscribe();
    assert.equal(resourceCount("FSEventWrap") - before, 1);
    assert.deepEqual(await change(filePath, current, { flag: "current" }), [{ key: "flag", oldValue: "repaired", newValue: "current" }]);
    assert.deepEqual(retired.received, []);
  } finally { hook.disable(); retired?.unsubscribe(); current?.unsubscribe(); }
}
async function refreshReplacement(provider, filePath, before, io) {
  const retired = observer(provider);
  await until(() => resourceCount("FSEventWrap") > before, "first watcher ready");
  let current;
  // Real async resource observation places replacement inside the watch read's await.
  const hook = createHook({ init(_id, type) {
    if (!isFileRequest(type)) return;
    hook.disable();
    queueMicrotask(() => {
      retired.unsubscribe();
      writeFileSync(filePath, '{"flag":"replacement-baseline"}');
      current = observer(provider);
    });
  } });
  try {
    writeFileSync(filePath, '{"flag":"retired-read"}');
    hook.enable();
    await until(() => current !== undefined, "watch read entered");
    await io.settle();
    assert.deepEqual(retired.received, []);
    assert.deepEqual(current.received, []);
    assert.equal(resourceCount("FSEventWrap") - before, 1);
    assert.deepEqual(await change(filePath, current, { flag: "current" }), [{ key: "flag", oldValue: "replacement-baseline", newValue: "current" }]);
  } finally { hook.disable(); retired.unsubscribe(); current?.unsubscribe(); }
}
async function pendingDispose(provider, _filePath, before, io) {
  const retired = observer(provider);
  assert.ok(io.pending() > 0, "dispose while initial read is unsettled");
  provider.dispose();
  await io.settle();
  assert.equal(resourceCount("FSEventWrap"), before);
  assert.deepEqual(retired.received, []);
  retired.unsubscribe();
}
async function callbackReplacement(provider, filePath, before, io) {
  const retired = [];
  let current;
  const stale = provider.onExternalChange((changes) => {
    retired.push(changes);
    stale();
    current = observer(provider);
  });
  try {
    await until(() => resourceCount("FSEventWrap") > before, "first watcher ready");
    await writeFile(filePath, '{"flag":"callback-baseline"}');
    await until(() => current !== undefined, "callback replacement");
    await io.settle();
    stale();
    assert.equal(retired.length, 1);
    assert.deepEqual(current.received, []);
    assert.deepEqual(await change(filePath, current, { flag: "current" }), [{ key: "flag", oldValue: "callback-baseline", newValue: "current" }]);
    assert.equal(retired.length, 1);
  } finally { stale(); current?.unsubscribe(); }
}
async function ownershipWorker(probe) {
  const before = resourceCount("FSEventWrap");
  let unhandled = 0;
  const onRejection = () => { unhandled++; };
  process.on("unhandledRejection", onRejection);
  const directory = await mkdtemp(join(tmpdir(), "weaver-watch-owner-"));
  const filePath = join(directory, "config.json");
  const provider = createFileSystemStorageProvider({ id: "disk", layer: "base", filePath, watchDebounceMs: 10 });
  const io = trackFileIO();
  try {
    await writeFile(filePath, '{"flag":"initial"}');
    await io.settle();
    await probe(provider, filePath, before, io);
  } finally {
    provider.dispose();
    await io.settle();
    io.close();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const afterDispose = resourceCount("FSEventWrap") - before;
    console.log(JSON.stringify({ before, afterDispose, leakedWatchers: afterDispose, unhandledRejections: unhandled }));
    await rm(directory, { recursive: true, force: true });
    process.removeListener("unhandledRejection", onRejection);
    assert.equal(afterDispose, 0);
    assert.equal(unhandled, 0);
  }
}
for (const probe of [rapidSubscription, staleUnsubscribe, malformedReplacement, refreshReplacement, pendingDispose, callbackReplacement]) {
  test(`isolated native watcher ownership: ${probe.name}`, () => {
    const source = `
      import assert from "node:assert/strict";
      import { createHook } from "node:async_hooks";
      import { renameSync, writeFileSync } from "node:fs";
      import { mkdtemp, writeFile, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { setTimeout as sleep } from "node:timers/promises";
      import { createFileSystemStorageProvider } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
      ${[resourceCount, isFileRequest, trackFileIO, until, observer, change, ownershipWorker, probe].map((fn) => fn.toString()).join("\n")}
      try { await ownershipWorker(${probe.name}); }
      catch (error) { console.error(error); process.exitCode = 1; }
      finally { process.exit(process.exitCode ?? 0); }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8", timeout: 8000 });
    console.log(`${probe.name}: ${result.stdout.trim()}`);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
