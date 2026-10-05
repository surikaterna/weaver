import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { configurationServiceWriteResultSchema } from "@weaver-conf/config-types";
import { binding, deferred, MemoryProvider, options, scopeOptions } from "./fixtures/memory.mjs";

test("distinct scope preloads serialize FIFO, identical calls dedupe, root never changes or emits", async () => {
  const firstGate = deferred(), secondGate = deferred();
  const setup = scopeOptions({ firstGate, secondGate }); const root = await createConfigurationService(setup.input);
  const revision = root.revision; let events = 0;
  const listener = () => events++; const off = root.onChange("/alpha/flag", listener);
  const one = root.preloadScope(setup.path1); assert.equal(root.preloadScope(setup.path1), one);
  const two = root.preloadScope(setup.path2);
  await Promise.resolve(); assert.equal(setup.first.loads, 1); assert.equal(setup.second.loads, 0);
  assert.equal(root.get("/alpha/flag"), "base"); assert.equal(root.revision, revision);
  firstGate.resolve(); await one;
  await Promise.resolve(); assert.equal(setup.second.loads, 1); secondGate.resolve(); await two;
  assert.equal(root.getForScope("/alpha/flag", setup.path1), "one"); assert.equal(root.getForScope("/alpha/flag", setup.path2), "two");
  await root.preloadScope(setup.path1); assert.equal(setup.first.loads, 1);
  assert.equal(setup.base.loads, 1); assert.equal(setup.last.loads, 1); assert.equal(root.revision, revision); assert.equal(events, 0);
  off(); off(); await root.dispose();
});

test("failed preload preserves ready identities and does not poison FIFO or consume initial revision", async () => {
  const setup = scopeOptions({ firstFails: true }); const root = await createConfigurationService(setup.input);
  const one = root.preloadScope(setup.path1), two = root.preloadScope(setup.path2);
  await assert.rejects(one, { code: "SERVER_DEGRADED" }); await two;
  assert.throws(() => root.getForScope("/alpha/flag", setup.path1), { code: "SCOPE_NOT_LOADED" });
  assert.equal(root.getForScope("/alpha/flag", setup.path2), "two"); assert.equal(root.revision, "1"); assert.equal(root.get("/alpha/flag"), "base"); await root.dispose();
});

test("terminal fence waits late loads, closes every owned hook once despite failures, never borrowed", async () => {
  const gate = deferred(); const setup = scopeOptions({ firstGate: gate }); const closed = [];
  setup.input.providers[0].ownership = { kind: "owned", dispose: () => { closed.push("base"); throw Error("SECRET"); } };
  setup.input.providers[1].ownership = { kind: "owned", dispose: () => { closed.push("first"); throw Error("SECRET"); } };
  setup.input.providers[2].ownership = { kind: "owned", dispose: () => { closed.push("unselected"); } };
  const root = await createConfigurationService(setup.input); let events = 0;
  const off = root.onChange("/alpha/flag", () => events++);
  const pending = root.preloadScope(setup.path1), queued = root.preloadScope(setup.path2);
  const settled = Promise.allSettled([pending, queued]); await Promise.resolve();
  assert.equal(setup.first.loads, 1); assert.equal(setup.second.loads, 0);
  const disposal = root.dispose(); assert.equal(root.dispose(), disposal); assert.deepEqual(closed, []);
  assert.throws(() => root.get("/alpha/flag"), { code: "DISPOSED" }); assert.throws(() => root.revision, { code: "DISPOSED" });
  const rejected = await root.set("/alpha/flag", 1, { layer: "base" });
  assert.equal(rejected.error.code, "DISPOSED"); assert.ok(configurationServiceWriteResultSchema.safeParse(rejected).success);
  await assert.rejects(root.preloadScope(setup.path2), { code: "DISPOSED" });
  gate.resolve();
  for (const outcome of await settled) { assert.equal(outcome.status, "rejected"); assert.equal(outcome.reason.code, "DISPOSED"); }
  const result = await disposal; assert.equal(result.ok, false); assert.deepEqual(closed, ["base", "first", "unselected"]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/); assert.equal(await root.dispose(), result);
  assert.deepEqual(result.error.details.cleanupFailedResources, ["base", "first"]);
  assert.equal(setup.second.loads, 0); assert.equal(events, 0); off(); off();
  assert.throws(() => root.getForScope("/alpha/flag", setup.path1), { code: "DISPOSED" });
  assert.throws(() => root.onChange("/alpha/flag", () => {}), { code: "DISPOSED" });
});

test("initial failure settles all loads before all owned cleanup; explicit degraded omits failures", async () => {
  const gate = deferred(); const good = new MemoryProvider("good", "good", { alpha: { flag: "yes" } }, gate);
  const bad = new MemoryProvider("bad", "bad", { alpha: new Date() }); const closed = [];
  const input = options([good, bad]); input.providers = input.providers.map((row) => ({ ...row, ownership: { kind: "owned", dispose: () => { closed.push(row.id); throw Error("SECRET"); } } }));
  const pending = createConfigurationService(input); await Promise.resolve(); assert.deepEqual(closed, []); gate.resolve();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "SERVER_DEGRADED"); assert.deepEqual(error.details.degradedProviders, ["bad"]);
    assert.deepEqual(error.details.cleanupFailedResources, ["good", "bad"]); assert.doesNotMatch(JSON.stringify(error), /SECRET/); return true;
  });
  assert.deepEqual(closed, ["good", "bad"]);
  const root = await createConfigurationService(options([good, bad], { failureMode: "allow-degraded" }));
  assert.equal(root.mode, "degraded"); assert.deepEqual(root.degradedProviders, ["bad"]);
  assert.deepEqual(root.inspect("/alpha/flag").contributions.map((item) => item.providerId), ["good"]); await root.dispose();
});

test("all root writes unavailable, unsupported operations truthful, provider mutation and events zero", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "before" } });
  const input = options([provider]); let disposals = 0, events = 0;
  input.providers[0].ownership = { kind: "owned", dispose: () => { disposals++; } };
  const root = await createConfigurationService(input);
  for (const key of ["transport", "client", "registry", "provider", "setMany", "registerSchema", "patchRegisteredPath", "setRegisteredObject"]) assert.equal(Object.hasOwn(root, key), false);
  root.writeAuthority = "server"; root.authority = { write: true }; root.writable = true;
  const off = root.onChange("/alpha/flag", () => events++);
  for (const result of [await root.set("/alpha/flag", "after", { layer: "base" }), await root.remove("/alpha/flag", { layer: "base" })]) { assert.equal(result.success, false); assert.equal(result.outcome, "rejected"); assert.equal(result.error.code, "WRITE_UNAVAILABLE"); assert.ok(configurationServiceWriteResultSchema.safeParse(result).success); assert.ok(JSON.parse(JSON.stringify(result)).error.message); }
  assert.equal((await root.reloadProvider("p")).error.code, "UNSUPPORTED_OPERATION"); assert.equal((await root.flush()).error.code, "UNSUPPORTED_OPERATION");
  assert.equal(root.revision, "1"); assert.equal(root.get("/alpha/flag"), "before"); assert.equal(events + provider.writes + provider.removes + provider.flushes, 0);
  const disposal = root.dispose(); assert.equal(root.dispose(), disposal);
  const result = await disposal; assert.equal(await root.dispose(), result); assert.equal(disposals, 1);
  for (const rejected of [await root.set("/alpha/flag", "after", { layer: "base" }), await root.remove("/alpha/flag", { layer: "base" })]) {
    assert.equal(rejected.error.code, "DISPOSED"); assert.ok(configurationServiceWriteResultSchema.safeParse(rejected).success);
  }
  assert.equal((await root.flush()).error.code, "DISPOSED"); off(); off();
  assert.equal(events + provider.writes + provider.removes + provider.flushes, 0);
});

test("resolved provider promise cannot publish past a same-turn terminal fence", async () => {
  const gate = deferred(); const setup = scopeOptions({ firstGate: gate }); let disposals = 0, events = 0;
  setup.input.providers[1].ownership = { kind: "owned", dispose: () => { disposals++; } };
  const root = await createConfigurationService(setup.input);
  root.onChange("/alpha/flag", () => events++);
  const pending = root.preloadScope(setup.path1); await Promise.resolve(); assert.equal(setup.first.loads, 1);
  gate.resolve(); const disposal = root.dispose(); assert.equal(disposals, 0);
  await assert.rejects(pending, { code: "DISPOSED" }); assert.equal((await disposal).ok, true);
  assert.equal(disposals, 1); assert.equal(events, 0);
  assert.throws(() => root.getForScope("/alpha/flag", setup.path1), { code: "DISPOSED" });
});
