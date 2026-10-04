import assert from "node:assert/strict";
import test from "node:test";
import { consoleLogger } from "@weaver-conf/config-engine";
import { configurationServiceWriteResultSchema } from "@weaver-conf/config-types";
import { WritableMemory, writable, writableOptions, writeBinding, writer } from "./fixtures/writable-memory.mjs";
import { deferred, registration } from "./fixtures/memory.mjs";
import { principal } from "./fixtures/authority.mjs";

for (const kind of ["throw", "false", "malformed", "contradictory", "getter", "flush"]) {
  test(`${kind} result is unknown, reads back once, stays degraded/fenced even with observed data`, async () => {
    const provider = new WritableMemory(), original = provider.write;
    let getters = 0;
    provider.write = async function (key, value) {
      await original.call(this, key, value);
      if (kind === "throw") throw Error("PRIVATE-PROVIDER");
      if (kind === "false") return { success: false, error: { code: "PRIVATE", message: "PRIVATE-PROVIDER" } };
      if (kind === "malformed") return { success: "true" };
      if (kind === "contradictory") return { success: true, error: { code: "PRIVATE", message: "PRIVATE-PROVIDER" } };
      if (kind === "getter") return { get success() { getters++; return true; } };
      return { success: true };
    };
    if (kind === "flush") provider.flush = async function () { this.flushes++; throw Error("PRIVATE-PROVIDER"); };
    const phases = [];
    const { root } = await writable({ provider, host: { writers: [writer(provider, { flush: kind === "flush" ? "required" : "none" })], audit: (record) => phases.push(record.phase) } });
    try {
      const revision = root.revision, loads = provider.loads;
      const result = await root.set("/alpha/flag", "observed", { layer: "base" });
      assert.equal(result.outcome, "unknown"); assert.equal(result.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(configurationServiceWriteResultSchema.safeParse(result).success, true);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|layer|revision/);
      assert.equal(root.get("/alpha/flag"), "observed"); assert.notEqual(root.revision, revision);
      assert.equal(root.mode, "degraded"); assert.deepEqual(root.degradedProviders, [provider.id]);
      assert.equal(provider.loads, loads + 1); assert.equal(provider.writes, 1); assert.equal(getters, 0);
      assert.equal((await root.remove("/alpha/flag", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
      assert.equal(provider.removes, 0); assert.equal(provider.loads, loads + 1);
      assert.equal(provider.flushes, kind === "flush" ? 1 : 0);
      assert.deepEqual(phases, ["before-dispatch", "unknown"]);
    } finally { await root.dispose(); }
  });
}
for (const kind of ["throw", "invalid"]) {
  test(`unknown ${kind} readback preserves the last confirmed generation`, async () => {
    const provider = new WritableMemory(), original = provider.load;
    let dispatched = false;
    provider.write = async function () { this.writes++; dispatched = true; throw Error("PRIVATE"); };
    provider.load = async function () {
      if (!dispatched) return original.call(this);
      this.loads++;
      if (kind === "throw") throw Error("PRIVATE");
      return { entries: { alpha: { flag: 123 } } };
    };
    const { root } = await writable({ provider });
    try {
      const before = root.inspect("/alpha/flag"), revision = root.revision;
      assert.equal((await root.set("/alpha/flag", "after", { layer: "base" })).outcome, "unknown");
      assert.equal(root.revision, revision); assert.deepEqual(root.inspect("/alpha/flag"), before);
      assert.equal(root.mode, "degraded"); assert.equal(provider.loads, 2);
    } finally { await root.dispose(); }
  });
}
test("guaranteed no-effect rejection does not read back or advance generation", async () => {
  const provider = new WritableMemory(); provider.write = async function () { this.writes++; return { success: false }; };
  const { root } = await writable({ provider, host: { writers: [writer(provider, { failureSemantics: "rejected-means-no-effect" })] } });
  try {
    const revision = root.revision;
    const result = await root.set("/alpha/flag", "after", { layer: "base" });
    assert.equal(result.outcome, "rejected"); assert.equal(result.error.code, "WRITE_ERROR");
    assert.equal(root.revision, revision); assert.equal(root.mode, "live"); assert.equal(provider.loads, 1);
  } finally { await root.dispose(); }
});
test("revocation and disposal after dispatch do not invent a rollback; cleanup waits required flush", async () => {
  const provider = new WritableMemory(), entered = deferred(), finish = deferred(); let closed = 0, released = 0;
  const input = writableOptions([provider]); input.providers[0].ownership = { kind: "owned", dispose: () => { released++; } };
  provider.flush = async function () { this.flushes++; entered.resolve(); await finish.promise; };
  const setup = await writable({ provider, input, host: { writers: [writer(provider, { flush: "required" })] } });
  const pending = setup.root.set("/alpha/flag", "committed", { layer: "base" });
  await entered.promise; setup.controller.revoke(setup.token);
  assert.throws(() => setup.root.get("/alpha/flag"), { code: "FORBIDDEN" });
  const disposal = setup.root.dispose().then((result) => { closed++; return result; });
  assert.equal(closed, 0);
  assert.equal(released, 0);
  assert.equal((await setup.root.set("/alpha/flag", "never", { layer: "base" })).error.code, "DISPOSED");
  finish.resolve(); assert.equal((await pending).success, true); assert.equal((await disposal).ok, true);
  assert.equal(closed, 1); assert.equal(provider.writes, 1); assert.equal(provider.flushes, 1);
  await setup.root.dispose(); assert.equal(released, 1);
});
test("audit and diagnostic failures never change committed or denied outcomes", async () => {
  const original = consoleLogger.error;
  consoleLogger.error = () => { throw Error("PRIVATE-LOGGER"); };
  let setup;
  try {
    setup = await writable({ host: { audit: () => { throw Error("PRIVATE-AUDIT"); } } });
    assert.equal((await setup.root.set("/alpha/flag", "committed", { layer: "base" })).success, true);
    assert.equal(setup.root.get("/alpha/flag"), "committed");
    assert.equal((await setup.root.set("/alpha/flag", 8, { layer: "base" })).error.code, "VALIDATION_ERROR");
    assert.equal(setup.provider.writes, 1);
  } finally { consoleLogger.error = original; await setup?.root.dispose(); }
});
test("readback invalid in one affected identity retains every snapshot and fences cold preload", async () => {
  const base = new WritableMemory(), scoped = new WritableMemory("scoped", "scope", { alpha: { cfg: { b: 2 } } }), cold = new WritableMemory("cold", "scope", {});
  const a = [{ scopeId: "area", value: "a" }], b = [{ scopeId: "area", value: "b" }];
  const input = writableOptions([base, scoped, cold]);
  input.schemas = [registration("east", "alpha", { type: "object", properties: { flag: { type: "string" }, cfg: { type: "object", maxProperties: 2, properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } } } } })];
  input.layers = [{ kind: "fixed", layer: "base", providerIds: [base.id] }, { kind: "scope", layer: "scope", providerIds: [scoped.id, cold.id] }];
  input.providers = [writeBinding(base), writeBinding(scoped, { scopePath: a }), writeBinding(cold, { scopePath: b })];
  const claims = principal(input); claims.grants.push(...[a, b].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  const original = base.write;
  base.write = async function (key, value) { await original.call(this, key, value); this.entries.alpha.cfg.c = 3; throw Error("unknown"); };
  const setup = await writable({ provider: base, input, claims });
  try {
    const port = setup.controller.forIdentity(setup.token, { environment: "east", scopePath: a }, "/alpha"); await port.prepare();
    const revisions = [setup.root.revision, port.revision];
    assert.equal((await setup.root.set("/alpha/flag", "candidate", { layer: "base" })).outcome, "unknown");
    assert.deepEqual([setup.root.revision, port.revision], revisions);
    assert.equal(setup.root.get("/alpha/flag"), "before"); assert.equal(port.get("/alpha/flag"), "before");
    const other = setup.controller.forIdentity(setup.token, { environment: "east", scopePath: b }, "/alpha");
    await assert.rejects(other.prepare(), { code: "WRITE_UNAVAILABLE" }); assert.equal(cold.loads, 0);
    assert.equal(base.loads, 2); assert.equal(base.writes, 1);
  } finally { await setup.root.dispose(); }
});
