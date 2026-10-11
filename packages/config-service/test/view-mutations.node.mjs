import assert from "node:assert/strict";
import { test } from "node:test";
import { writable, WritableMemory, writableOptions, writer } from "./fixtures/writable-memory.mjs";
import { registration, viewSchema } from "./fixtures/memory.mjs";
import { principal } from "./fixtures/authority.mjs";

async function fixture(host = {}, configure = () => {}) {
  const low = new WritableMemory("low", "base", { alpha: { flag: "base", panel: { a: 1, b: 2 }, instances: { one: { flag: "low-one", panel: { a: 3 } }, other: { flag: "other" } } } });
  const high = new WritableMemory("high", "high", { alpha: { flag: "high-base", instances: { one: { flag: "high-one" } } } });
  configure(low, high);
  const input = writableOptions([low, high]); input.schemas = [registration("east", "alpha", viewSchema())];
  const claims = principal(input); claims.grants[0].sensitive = true;
  claims.grants.push({ ...claims.grants[0], views: ["one", "other", "absent"] });
  const setup = await writable({ provider: low, input, claims, host: { writers: [writer(low), writer(high)], ...host } });
  const one = setup.reader.forView("one"), other = setup.reader.forView("other");
  await one.prepare(); await other.prepare();
  const apply = (...items) => setup.mutations.apply(items.map((item) => ({ identity: input.identity, namespace: "/alpha", layer: "base", ...item })));
  return { ...setup, low, high, one, other, apply };
}

test("sole apply executor compiles selected-view writes, raw patches and layer-local reset", async () => {
  const setup = await fixture();
  try {
    assert.equal(setup.one.get(["flag"]), "high-one");
    let result = await setup.apply({ operation: "remove", viewId: "one", layer: "high", path: "/alpha" });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(setup.one.get(["flag"]), "low-one");
    assert.equal(setup.reader.get(["flag"]), "high-base");
    assert.equal(setup.other.get(["flag"]), "other");
    result = await setup.apply({ operation: "patch", viewId: "one", path: "/alpha/panel/a", value: 42 });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(setup.low.entries.alpha.instances.one.panel, { a: 42 });
    assert.deepEqual(setup.one.get(["panel"]), { a: 42, b: 2 });
    assert.equal(setup.one.revision, result.revisions[0].revision);
    result = await setup.apply({ operation: "remove", viewId: "one", path: "/alpha" });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(setup.one.get(["flag"]), "high-base");
    assert.equal(Object.hasOwn(setup.low.entries.alpha.instances, "one"), false);
    assert.equal(setup.low.entries.alpha.instances.other.flag, "other");
    assert.equal(setup.low.entries.alpha.flag, "base");
    result = await setup.apply({ operation: "set", viewId: "one", path: "/alpha/flag", value: null });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(setup.one.get(["flag"]), null);
  } finally { await setup.root.dispose(); }
});

test("base namespace replace/remove preserves raw view storage; ancestor erasure and injection deny", async () => {
  const setup = await fixture();
  try {
    const stored = structuredClone(setup.low.entries.alpha.instances);
    let result = await setup.apply({ operation: "set", path: "/alpha", value: { flag: "new-base" } });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(setup.low.entries.alpha.instances, stored);
    result = await setup.apply({ operation: "remove", path: "/alpha" });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(setup.low.entries.alpha, { instances: stored });
    const effects = setup.low.writes + setup.low.removes;
    for (const command of [
      { operation: "set", path: "/alpha", value: null },
      { operation: "set", path: "/alpha", value: { instances: { other: {} } } },
      { operation: "remove", path: "/alpha/instances/other" },
      { operation: "remove", path: "/alpha", viewId: "not-granted" },
      { operation: "remove", path: "/alpha", viewId: "one", storagePath: "/alpha" },
    ]) assert.equal((await setup.apply(command)).success, false);
    assert.equal(setup.low.writes + setup.low.removes, effects);
  } finally { await setup.root.dispose(); }
});

test("mixed-view batches perform all policy preflight before any effects and callbacks see logical paths", async () => {
  const requests = [];
  const setup = await fixture({ hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite(_principal, request) {
    requests.push(request); return request.viewId === "other" ? "denied" : "allowed";
  } } });
  try {
    const before = setup.one.snapshot(["flag"]);
    const result = await setup.apply(
      { operation: "set", viewId: "one", path: "/alpha/flag", value: "would-write" },
      { operation: "remove", viewId: "other", path: "/alpha" },
    );
    assert.equal(result.success, false);
    assert.equal(result.error.code, "FORBIDDEN");
    assert.equal(setup.low.writes + setup.low.removes + setup.high.writes + setup.high.removes, 0);
    assert.deepEqual(setup.one.snapshot(["flag"]), before);
    assert.ok(requests.some((request) => request.viewId === "one"));
    assert.ok(requests.every((request) => !request.path.includes("instances")));
  } finally { await setup.root.dispose(); }
});

test("known partial view batch publishes only its committed prefix with one binding flush", async () => {
  const setup = await fixture({ writers: [{ providerId: "low", operation: { kind: "write" }, flush: "required", failureSemantics: "rejected-means-no-effect" }, { providerId: "high", operation: { kind: "write" }, flush: "none", failureSemantics: "unknown" }] }, (low) => {
    const write = low.write;
    low.write = async function (key, value) { if (value === "stop") return { success: false }; return write.call(this, key, value); };
  });
  try {
    const result = await setup.apply({ operation: "set", viewId: "other", path: "/alpha/flag", value: "prefix" }, { operation: "set", viewId: "one", path: "/alpha/flag", value: "stop" });
    assert.equal(result.outcome, "partial", JSON.stringify(result));
    assert.deepEqual(result.results.map((item) => item.effect), ["committed", "rejected"]);
    assert.equal(setup.other.get(["flag"]), "prefix");
    assert.equal(setup.one.get(["flag"]), "high-one");
    assert.equal(setup.low.entries.alpha.instances.one.flag, "low-one");
    assert.equal(setup.other.revision, result.revisions[0].revision);
    assert.equal(setup.low.flushes, 1);
  } finally { await setup.root.dispose(); }
});

test("unknown view outcome reconciles all prepared selections once and fences further effects", async () => {
  const setup = await fixture({}, (low) => {
    const write = low.write;
    low.write = async function (key, value) { await write.call(this, key, value); throw Error("PRIVATE provider failure"); };
  });
  try {
    const loads = setup.low.loads;
    const result = await setup.apply({ operation: "set", viewId: "other", path: "/alpha/flag", value: "uncertain" });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(setup.other.get(["flag"]), "uncertain");
    assert.equal(setup.one.get(["flag"]), "high-one");
    assert.equal(setup.root.mode, "degraded");
    assert.equal(setup.low.loads, loads + 1);
    assert.equal((await setup.apply({ operation: "remove", viewId: "other", path: "/alpha" })).error.code, "WRITE_UNAVAILABLE");
    assert.equal(setup.low.writes, 1);
    const missing = setup.reader.forView("absent"); await missing.prepare();
    assert.equal(missing.get(["flag"]), "high-base");
    assert.equal(setup.low.loads, loads + 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  } finally { await setup.root.dispose(); }
});
