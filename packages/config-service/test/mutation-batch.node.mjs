import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationMutationResultSchema } from "@weaver-conf/config-types";
import { writable, WritableMemory, writableOptions, writer, commands } from "./fixtures/writable-memory.mjs";
import { deferred, registration } from "./fixtures/memory.mjs";

function check(result) { assert.equal(configurationMutationResultSchema.safeParse(result).success, true, JSON.stringify(result)); return result; }
function operation(path, value, extra = {}) { return { operation: "set", path, value, ...extra }; }

test("one canonical mutation port replaces root/query writers; immutable ordered overlap uses one flush and generation", async () => {
  const provider = new WritableMemory(), gate = deferred(), entered = deferred();
  provider.flush = async function () { this.flushes++; entered.resolve(); await gate.promise; };
  const setup = await writable({ provider, host: { writers: [writer(provider, { flush: "required" })] } });
  try {
    const { root, controller, token, mutations, input } = setup;
    assert.deepEqual(Object.keys(mutations), ["apply"]);
    const query = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
    for (const port of [root, query]) { assert.equal("set" in port, false); assert.equal("remove" in port, false); }
    const revision = query.revision;
    const list = commands(input, operation("/alpha/cfg", { a: 2 }, { ifRevision: revision }), operation("/alpha/cfg/a", 3, { ifRevision: revision }));
    const pending = mutations.apply(list);
    list[0].value.a = 99; list[1].value = 99; list.reverse();
    await entered.promise;
    assert.equal(query.get(["cfg", "a"]), 1); assert.equal(query.revision, revision);
    assert.equal(provider.entries.alpha.cfg.a, 3); assert.equal(provider.writes, 2);
    gate.resolve(); const result = check(await pending);
    assert.equal(result.success, true); assert.deepEqual(result.results.map((item) => item.effect), ["committed", "committed"]);
    assert.equal(result.revisions.length, 1); assert.equal(result.revisions[0].revision, query.revision);
    assert.equal(provider.flushes, 1); assert.equal(query.get(["cfg", "a"]), 3);
  } finally { gate.resolve(); await setup.root.dispose(); }
});

test("later invalid or unauthorized command rejects every effect, and every prefix must be valid", async () => {
  const setup = await writable();
  try {
    for (const second of [operation("/alpha/flag", 123), operation("/beta/flag", "unauthorized")]) {
      const result = check(await setup.mutations.apply(commands(setup.input, operation("/alpha/flag", "first"), second)));
      assert.equal(result.outcome, "rejected"); assert.deepEqual(result.results.map((item) => item.effect), ["not-attempted", "rejected"]);
      assert.equal(setup.provider.writes + setup.provider.flushes, 0);
    }
    const result = check(await setup.mutations.apply(commands(setup.input, operation("/alpha/flag", 123), operation("/alpha/flag", "repaired"))));
    assert.equal(result.outcome, "rejected"); assert.equal(result.results[0].effect, "rejected");
    assert.equal(setup.provider.writes, 0);
  } finally { await setup.root.dispose(); }
});

test("known provider stop commits only flushed prefix, leaves suffix unattempted, permits a later batch", async () => {
  const provider = new WritableMemory(), original = provider.write;
  provider.write = async function (key, value) { if (value === "stop") { this.writes++; return { success: false }; } return original.call(this, key, value); };
  const setup = await writable({ provider, host: { writers: [writer(provider, { flush: "required", failureSemantics: "rejected-means-no-effect" })] } });
  try {
    const result = check(await setup.mutations.apply(commands(setup.input, operation("/alpha/flag", "first"), operation("/alpha/flag", "stop"), operation("/alpha/flag", "never"))));
    assert.equal(result.outcome, "partial"); assert.deepEqual(result.results.map((item) => item.effect), ["committed", "rejected", "not-attempted"]);
    assert.equal(provider.writes, 2); assert.equal(provider.flushes, 1); assert.equal(provider.loads, 1);
    assert.equal(setup.reader.get(["flag"]), "first"); assert.equal(setup.root.mode, "live");
    assert.equal(check(await setup.mutations.apply(commands(setup.input, operation("/alpha/flag", "later")))).success, true);
  } finally { await setup.root.dispose(); }
});

test("revocation between commands stops further dispatch but finalizes the accepted prefix", async () => {
  const provider = new WritableMemory(), original = provider.write;
  let revoke;
  provider.write = async function (...args) { const result = await original.apply(this, args); revoke(); return result; };
  const setup = await writable({ provider, host: { writers: [writer(provider, { flush: "required" })] } });
  revoke = () => setup.controller.revoke(setup.token);
  try {
    const result = check(await setup.mutations.apply(commands(setup.input, operation("/alpha/flag", "first"), operation("/alpha/flag", "never"))));
    assert.equal(result.outcome, "partial"); assert.equal(result.error.code, "FORBIDDEN");
    assert.equal(provider.entries.alpha.flag, "first"); assert.equal(provider.writes, 1); assert.equal(provider.flushes, 1);
  } finally { await setup.root.dispose(); }
});

test("patch uses the selected raw layer, supports bounded arrays/null, and does not copy effective fallback siblings", async () => {
  const base = new WritableMemory("base", "base", { alpha: { object: { low: 1 }, list: [1] } });
  const upper = new WritableMemory("upper", "upper", { alpha: { object: { high: 2 } } });
  const input = writableOptions([base, upper]);
  input.schemas = [registration("east", "alpha", { type: "object", properties: {
    object: { type: "object", additionalProperties: true }, list: { type: "array", items: { type: ["number", "null"] } },
  } })];
  const setup = await writable({ provider: base, input });
  try {
    const result = check(await setup.mutations.apply(commands(input,
      { operation: "patch", path: "/alpha/object/low", value: 3 },
      { operation: "patch", path: "/alpha/list/1", value: null })));
    assert.equal(result.success, true); assert.deepEqual(base.entries.alpha.object, { low: 3 });
    assert.deepEqual(setup.reader.get(["object"]), { low: 3, high: 2 });
    assert.deepEqual(setup.reader.get(["list"]), [1, null]);
    assert.equal((await setup.mutations.apply(commands(input, { operation: "patch", path: "/alpha/list/4", value: 4 }))).outcome, "rejected");
    assert.equal((await setup.mutations.apply(commands(input, operation("/alpha/list/0", 3)))).error.code, "UNSUPPORTED_OPERATION");
  } finally { await setup.root.dispose(); }
});

for (const terminal of ["expiry", "disposal"]) test(`${terminal} after first accepted command finalizes prefix and waits owned cleanup`, async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]), entered = deferred(), release = deferred();
  let now = 0, closed = 0, setup;
  input.providers[0].ownership = { kind: "owned", dispose() { closed++; } };
  const original = provider.write; let disposal;
  provider.write = async function (...args) {
    const result = await original.apply(this, args);
    if (terminal === "expiry") now = 10; else disposal = setup.root.dispose();
    return result;
  };
  provider.flush = async function () { this.flushes++; entered.resolve(); await release.promise; };
  const { principal } = await import("./fixtures/authority.mjs");
  setup = await writable({ provider, input, claims: principal(input, { expiresAt: 10 }), host: { now: () => now, writers: [writer(provider, { flush: "required" })] } });
  try {
    const pending = setup.mutations.apply(commands(input, operation("/alpha/flag", "accepted"), operation("/alpha/flag", "never")));
    await entered.promise; assert.equal(closed, 0); assert.equal(provider.writes, 1);
    release.resolve(); const result = check(await pending);
    assert.equal(result.outcome, "partial"); assert.equal(result.error.code, terminal === "expiry" ? "FORBIDDEN" : "DISPOSED");
    assert.equal(provider.entries.alpha.flag, "accepted");
    if (disposal) { await disposal; assert.equal(closed, 1); }
  } finally { release.resolve(); await setup.root.dispose(); }
  assert.equal(closed, 1);
});
