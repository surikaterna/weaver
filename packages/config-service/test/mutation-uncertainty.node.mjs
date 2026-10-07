import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationMutationResultSchema } from "@weaver-conf/config-types";
import { writable, WritableMemory, writableOptions, writer, commands } from "./fixtures/writable-memory.mjs";
import { deferred } from "./fixtures/memory.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";

for (const failFirst of [false, true]) for (const invalid of [false, true]) test(`A/B/A flush uncertainty observes all bindings, failFirst=${failFirst} invalid=${invalid}`, async () => {
  const a = new WritableMemory("a", "base"), b = new WritableMemory("b", "upper", {});
  const input = writableOptions([a, b]), entered = deferred(), release = deferred();
  const order = [];
  a.flush = async function () { this.flushes++; order.push("a"); if (failFirst) throw Error("PRIVATE"); };
  b.flush = async function () { this.flushes++; order.push("b"); if (!failFirst) throw Error("PRIVATE"); };
  const original = b.load;
  b.load = async function () { if (this.loads) { entered.resolve(); await release.promise; if (invalid) { this.loads++; return { entries: { alpha: { flag: 123 } } }; } } return original.call(this); };
  const setup = await writable({ provider: a, input, host: { writers: [writer(a, { flush: "required" }), writer(b, { flush: "required" })] } });
  try {
    const revision = setup.reader.revision;
    const pending = setup.mutations.apply(commands(input,
      { operation: "set", path: "/alpha/flag", value: "A1" },
      { operation: "set", path: "/alpha/flag", value: "B1", layer: "upper" },
      { operation: "set", path: "/alpha/flag", value: "A2" }));
    await entered.promise;
    assert.equal(setup.reader.revision, revision); assert.equal(setup.reader.get(["flag"]), "before");
    release.resolve(); const result = await pending;
    assert.equal(configurationMutationResultSchema.safeParse(result).success, true);
    assert.equal(result.outcome, "unknown"); assert.equal("revisions" in result, false);
    assert.deepEqual(result.results.map((item) => item.effect), failFirst ? ["unknown", "committed", "unknown"] : ["committed", "unknown", "committed"]);
    assert.deepEqual(order, ["a", "b"]); assert.equal(a.loads, 2); assert.equal(b.loads, 2);
    assert.equal(a.writes, 2); assert.equal(b.writes, 1); assert.equal(a.entries.alpha.flag, "A2");
    assert.equal(setup.reader.get(["flag"]), invalid ? "before" : "B1");
    if (invalid) assert.equal(setup.reader.revision, revision);
    assert.equal(setup.root.mode, "degraded"); assert.deepEqual(setup.root.degradedProviders, ["a", "b"]);
    assert.equal((await setup.mutations.apply(commands(input, { operation: "remove", path: "/alpha/flag" }))).error.code, "WRITE_UNAVAILABLE");
  } finally { release.resolve(); await setup.root.dispose(); }
});

test("uncertain co-located metadata mismatch fences every payload query without accepting foreign registry state", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  let corrupt = false; const original = provider.write;
  provider.write = async function (...args) {
    const result = await original.apply(this, args);
    if (corrupt) { this.entries._weaver.registry.schemas = { invalid: "PRIVATE" }; throw Error("PRIVATE"); }
    return result;
  };
  const setup = await writable({ provider, input, host: { registry: { storage: { kind: "provider", providerId: provider.id } }, writers: [writer(provider, { flush: "required" })] } });
  const query = setup.controller.forIdentity(setup.token, { identity: input.identity, namespace: "/alpha" });
  const schemas = setup.controller.forSchemas(setup.controller.mint(schemaClaims(input)));
  try {
    const loads = provider.loads, flushes = provider.flushes; corrupt = true;
    const result = await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "uncertain" }));
    assert.equal(result.outcome, "unknown"); assert.equal(provider.loads, loads + 1); assert.equal(provider.flushes, flushes + 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    for (const read of [() => setup.reader.get(["flag"]), () => setup.reader.get(["flag"], { layer: "base" }),
      () => setup.reader.get(), () => query.snapshot(["flag"]), () => query.validate(), () => schemas.snapshot()])
      assert.throws(read, { code: "SERVER_DEGRADED" });
    assert.equal(setup.root.mode, "degraded"); assert.deepEqual(setup.root.degradedProviders, [provider.id]);
  } finally { await setup.root.dispose(); }
  assert.throws(() => query.get(["flag"]), { code: "DISPOSED" });
});

test("equivalent versionless registry observation normalizes through the one codec without schema fencing", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  let uncertain = false; const original = provider.write;
  provider.write = async function (...args) {
    const result = await original.apply(this, args);
    if (uncertain) { delete this.entries._weaver.registry.schemas.version; throw Error("uncertain"); }
    return result;
  };
  const setup = await writable({ provider, input, host: { registry: { storage: { kind: "provider", providerId: provider.id } } } });
  try {
    uncertain = true;
    const result = await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "observed" }));
    assert.equal(result.outcome, "unknown"); assert.equal(setup.reader.get(["flag"]), "observed");
    assert.equal(setup.root.mode, "degraded"); assert.equal(provider.loads, 2);
  } finally { await setup.root.dispose(); }
});
