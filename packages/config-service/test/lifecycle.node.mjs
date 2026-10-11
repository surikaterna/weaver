import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { hostedReader, readonlyHost } from "./fixtures/authority.mjs";
import { deferred, MemoryProvider, options, scopeOptions } from "./fixtures/memory.mjs";

test("distinct scope preloads serialize FIFO, identical calls dedupe, root never changes or emits", async () => {
  const firstGate = deferred(), secondGate = deferred();
  const setup = scopeOptions({ firstGate, secondGate }); const { root, reader } = await hostedReader(setup.input);
  const revision = reader.revision; let events = 0;
  const listener = () => events++; const off = reader.onChange(["flag"], listener);
  const first = reader.withScope(setup.path1), second = reader.withScope(setup.path2);
  const one = first.prepare(), duplicate = first.prepare();
  const two = second.prepare();
  await Promise.resolve(); assert.equal(setup.first.loads, 1); assert.equal(setup.second.loads, 0);
  assert.equal(reader.get(["flag"]), "base"); assert.equal(reader.revision, revision);
  firstGate.resolve(); await one; await duplicate;
  await Promise.resolve(); assert.equal(setup.second.loads, 1); secondGate.resolve(); await two;
  assert.equal(first.get(["flag"]), "one"); assert.equal(second.get(["flag"]), "two");
  await first.prepare(); assert.equal(setup.first.loads, 1);
  assert.equal(setup.base.loads, 1); assert.equal(setup.last.loads, 1); assert.equal(reader.revision, revision); assert.equal(events, 0);
  off(); off(); await root.dispose();
});

test("failed preload preserves ready identities and does not poison FIFO or consume initial revision", async () => {
  const setup = scopeOptions({ firstFails: true }); const { root, reader } = await hostedReader(setup.input);
  const revision = reader.revision, first = reader.withScope(setup.path1), second = reader.withScope(setup.path2);
  const one = first.prepare(), two = second.prepare();
  await assert.rejects(one, { code: "SERVER_DEGRADED" }); await two;
  assert.throws(() => first.get(["flag"]), { code: "SCOPE_NOT_LOADED" });
  assert.equal(second.get(["flag"]), "two"); assert.equal(reader.revision, revision); assert.equal(reader.get(["flag"]), "base"); await root.dispose();
});

test("terminal fence waits late loads, closes every owned hook once despite failures, never borrowed", async () => {
  const gate = deferred(); const setup = scopeOptions({ firstGate: gate }); const closed = [];
  setup.input.providers[0].ownership = { kind: "owned", dispose: () => { closed.push("base"); throw Error("SECRET"); } };
  setup.input.providers[1].ownership = { kind: "owned", dispose: () => { closed.push("first"); throw Error("SECRET"); } };
  setup.input.providers[2].ownership = { kind: "owned", dispose: () => { closed.push("unselected"); } };
  const { root, reader } = await hostedReader(setup.input); let events = 0;
  const off = reader.onChange(["flag"], () => events++);
  const first = reader.withScope(setup.path1), second = reader.withScope(setup.path2);
  const pending = first.prepare(), queued = second.prepare();
  const settled = Promise.allSettled([pending, queued]); await Promise.resolve();
  assert.equal(setup.first.loads, 1); assert.equal(setup.second.loads, 0);
  const disposal = root.dispose(); assert.equal(root.dispose(), disposal); assert.deepEqual(closed, []);
  assert.throws(() => reader.get(["flag"]), { code: "DISPOSED" }); assert.throws(() => reader.revision, { code: "DISPOSED" });
  assert.equal("set" in root, false); assert.equal("remove" in root, false);
  await assert.rejects(second.prepare(), { code: "DISPOSED" });
  gate.resolve();
  for (const outcome of await settled) { assert.equal(outcome.status, "rejected"); assert.equal(outcome.reason.code, "DISPOSED"); }
  const result = await disposal; assert.equal(result.ok, false); assert.deepEqual(closed, ["base", "first", "unselected"]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/); assert.equal(await root.dispose(), result);
  assert.deepEqual(result.error.details.cleanupFailedResources, ["base", "first"]);
  assert.equal(setup.second.loads, 0); assert.equal(events, 0); off(); off();
  assert.throws(() => first.get(["flag"]), { code: "DISPOSED" });
  assert.throws(() => reader.onChange(["flag"], () => {}), { code: "DISPOSED" });
});

test("initial failure settles all loads before all owned cleanup; explicit degraded omits failures", async () => {
  const gate = deferred(); const good = new MemoryProvider("good", "good", { alpha: { flag: "yes" } }, gate);
  const bad = new MemoryProvider("bad", "bad", { alpha: new Date() }); const closed = [];
  const input = options([good, bad]); input.providers = input.providers.map((row) => ({ ...row, ownership: { kind: "owned", dispose: () => { closed.push(row.id); throw Error("SECRET"); } } }));
  const pending = createConfigurationService(input, readonlyHost(input)); await Promise.resolve(); assert.deepEqual(closed, []); gate.resolve();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "SERVER_DEGRADED"); assert.deepEqual(error.details.degradedProviders, ["bad"]);
    assert.deepEqual(error.details.cleanupFailedResources, ["good", "bad"]); assert.doesNotMatch(JSON.stringify(error), /SECRET/); return true;
  });
  assert.deepEqual(closed, ["good", "bad"]);
  const { root, reader } = await hostedReader(options([good, bad], { failureMode: "allow-degraded" }));
  assert.equal(root.mode, "degraded"); assert.deepEqual(root.degradedProviders, ["bad"]);
  assert.deepEqual(reader.inspect(["flag"]).contributions.map((item) => item.providerId), ["good"]); await root.dispose();
});

test("root has no data writes; unchanged reload and undeclared flush produce no mutation or event", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "before" } });
  const input = options([provider]); let disposals = 0, events = 0;
  input.providers[0].ownership = { kind: "owned", dispose: () => { disposals++; } };
  const { root, reader } = await hostedReader(input);
  const revision = reader.revision;
  for (const key of ["transport", "client", "registry", "provider", "setMany", "registerSchema", "patchRegisteredPath", "setRegisteredObject"]) assert.equal(Object.hasOwn(root, key), false);
  for (const key of ["writeAuthority", "authority", "writable"]) assert.throws(() => { root[key] = true; }, TypeError);
  const off = reader.onChange(["flag"], () => events++);
  for (const key of ["set", "remove", "apply", "forMutations"]) assert.equal(key in root, false);
  assert.equal((await root.reloadProvider("p")).ok, true); assert.equal((await root.flush()).ok, true);
  assert.equal(reader.revision, revision); assert.equal(reader.get(["flag"]), "before"); assert.equal(events + provider.writes + provider.removes + provider.flushes, 0);
  const disposal = root.dispose(); assert.equal(root.dispose(), disposal);
  const result = await disposal; assert.equal(await root.dispose(), result); assert.equal(disposals, 1);
  for (const key of ["set", "remove", "apply", "forMutations"]) assert.equal(key in root, false);
  assert.equal((await root.flush()).error.code, "DISPOSED"); off(); off();
  assert.equal(events + provider.writes + provider.removes + provider.flushes, 0);
});

test("resolved provider promise cannot publish past a same-turn terminal fence", async () => {
  const gate = deferred(); const setup = scopeOptions({ firstGate: gate }); let disposals = 0, events = 0;
  setup.input.providers[1].ownership = { kind: "owned", dispose: () => { disposals++; } };
  const { root, reader } = await hostedReader(setup.input);
  reader.onChange(["flag"], () => events++);
  const selected = reader.withScope(setup.path1);
  const pending = selected.prepare(); await Promise.resolve(); assert.equal(setup.first.loads, 1);
  gate.resolve(); const disposal = root.dispose(); assert.equal(disposals, 0);
  await assert.rejects(pending, { code: "DISPOSED" }); assert.equal((await disposal).ok, true);
  assert.equal(disposals, 1); assert.equal(events, 0);
  assert.throws(() => selected.get(["flag"]), { code: "DISPOSED" });
});
