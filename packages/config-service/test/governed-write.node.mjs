import assert from "node:assert/strict";
import test from "node:test";
import { configurationMutationResultSchema } from "@weaver-conf/config-types";
import { WritableMemory, writable, writableOptions, writeBinding, writer, commands } from "./fixtures/writable-memory.mjs";
import { deferred, registration } from "./fixtures/memory.mjs";
import { principal } from "./fixtures/authority.mjs";

test("canonical mutation port publishes real primitive writes to captured queries", async () => {
  const provider = new WritableMemory();
  const input = writableOptions([provider]);
  input.schemas = [registration("east", "alpha", { type: "object", properties: {
    flag: { type: "string" }, "literal.dot": { type: "string" }, "雪": { type: "null" }, cfg: { type: "object", properties: { a: { type: "number" } } },
  } })];
  const { root, reader, controller, token, mutations } = await writable({ provider, input });
  let events = 0;
  const unsubscribe = reader.onChange(["flag"], () => { events++; });
  try {
    const port = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
    const initial = reader.revision;
    for (const [path, value] of [["/alpha/flag", "after"], ["/alpha/literal.dot", "dot"], ["/alpha/雪", null], ["/alpha/cfg/a", 2]]) {
      const result = await mutations.apply(commands(input, { operation: "set", path, value, ifRevision: reader.revision }));
      assert.equal(result.success, true); assert.equal(configurationMutationResultSchema.safeParse(result).success, true);
      assert.deepEqual(Object.keys(result).sort(), ["results", "revisions", "success"]);
      assert.notEqual(result.revisions[0].revision, "provider-revision"); assert.equal(port.get(path.split("/").slice(2)), value);
      assert.equal(port.revision, reader.revision);
    }
    assert.notEqual(reader.revision, initial);
    assert.equal((await provider.load()).entries.alpha["literal.dot"], "dot");
    assert.equal((await mutations.apply(commands(input, { operation: "remove", path: "/alpha/literal.dot" }))).success, true);
    assert.equal(reader.get(["literal.dot"]), undefined);
    assert.equal((await provider.load()).entries.alpha["literal.dot"], undefined);
    const revision = reader.revision;
    assert.equal((await mutations.apply(commands(input, { operation: "remove", path: "/alpha/literal.dot" }))).success, true);
    assert.notEqual(reader.revision, revision);
    assert.equal(events, 1);
  } finally { unsubscribe(); await root.dispose(); }
});
test("required flush keeps old generation visible; queued conditional writes have one winner", async () => {
  const provider = new WritableMemory(), flush = deferred(), entered = deferred();
  provider.flush = async function () { this.flushes++; entered.resolve(); await flush.promise; };
  const { root, reader, mutations, input } = await writable({ provider, host: { writers: [writer(provider, { flush: "required" })] } });
  try {
    const before = reader.inspect(["flag"]), revision = reader.revision;
    const first = mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "first", ifRevision: revision }));
    const second = mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "second", ifRevision: revision }));
    await entered.promise;
    assert.equal(reader.revision, revision); assert.deepEqual(reader.inspect(["flag"]), before);
    assert.equal(provider.entries.alpha.flag, "first"); assert.equal(provider.writes, 1);
    flush.resolve(); assert.equal((await first).success, true);
    assert.equal((await second).error.code, "REVISION_CONFLICT");
    assert.equal(provider.writes, 1); assert.equal(provider.flushes, 1); assert.equal(reader.get(["flag"]), "first");
  } finally { flush.resolve(); await root.dispose(); }
});
test("cold request writes do not load; fixed writes update loaded scopes and future preloads", async () => {
  const base = new WritableMemory(), one = new WritableMemory("one", "scope", { alpha: { flag: "scope-one" } }), two = new WritableMemory("two", "scope", { alpha: { flag: "scope-two" } });
  const a = [{ scopeId: "area", value: "a" }], b = [{ scopeId: "area", value: "b" }];
  const input = writableOptions([base, one, two]);
  input.layers = [{ kind: "scope", layer: "scope", providerIds: ["one", "two"] }, { kind: "fixed", layer: "base", providerIds: [base.id] }];
  input.providers = [writeBinding(one, { scopePath: a }), writeBinding(two, { scopePath: b }), writeBinding(base)];
  const claims = principal(input);
  claims.grants.push(...[a, b].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  const { root, controller, token, mutations } = await writable({ provider: base, input, claims });
  try {
    const port = controller.forIdentity(token, { identity: { environment: "east", scopePath: a }, namespace: "/alpha" });
    const scopedCommand = { operation: "set", path: "/alpha/flag", value: "no", identity: port.selection.identity };
    assert.equal((await mutations.apply(commands(input, scopedCommand))).error.code, "SCOPE_NOT_LOADED");
    assert.equal(one.loads, 0); assert.equal(two.loads, 0);
    await port.prepare();
    assert.equal((await mutations.apply(commands(input, scopedCommand))).error.code, "FORBIDDEN");
    const old = port.revision;
    assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "shared" }))).success, true);
    assert.equal(port.get(["flag"]), "shared"); assert.notEqual(port.revision, old);
    const later = controller.forIdentity(token, { identity: { environment: "east", scopePath: b }, namespace: "/alpha" });
    await later.prepare(); assert.equal(later.get(["flag"]), "shared");
  } finally { await root.dispose(); }
});
test("all raw siblings and every affected scoped effective candidate validate before dispatch", async () => {
  const base = new WritableMemory("disk", "base", { alpha: { flag: "before", cfg: { a: "invalid" } } });
  let setup = await writable({ provider: base });
  try {
    assert.equal((await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "after" }))).error.code, "VALIDATION_ERROR");
    assert.equal(base.writes, 0);
  } finally { await setup.root.dispose(); }
  base.entries = { alpha: { flag: "before" } };
  const scoped = new WritableMemory("scoped", "scope", { alpha: { cfg: { a: "invalid" } } });
  const scopePath = [{ scopeId: "area", value: "a" }];
  const input = writableOptions([base, scoped]);
  input.layers[1].kind = "scope"; input.providers[1] = writeBinding(scoped, { scopePath });
  const claims = principal(input); claims.grants.push({ ...claims.grants[0], identity: { environment: "east", scopePath } });
  setup = await writable({ provider: base, input, claims });
  try {
    const port = setup.controller.forIdentity(setup.token, { identity: { environment: "east", scopePath }, namespace: "/alpha" });
    await port.prepare();
    const revision = setup.reader.revision;
    assert.equal((await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "after" }))).error.code, "VALIDATION_ERROR");
    assert.equal(base.writes, 0); assert.equal(setup.reader.revision, revision);
  } finally { await setup.root.dispose(); }
});

test("scoped parent mutation updates descendants only and never falls back from an unwritable deepest binding", async () => {
  const base = new WritableMemory(), parent = new WritableMemory("parent", "scope", {}), child = new WritableMemory("child", "scope", {});
  const a = [{ scopeId: "area", value: "a" }], b = [...a, { scopeId: "site", value: "b" }];
  const input = writableOptions([base, parent, child]);
  input.layers = [{ kind: "fixed", layer: "base", providerIds: [base.id] }, { kind: "scope", layer: "scope", providerIds: [parent.id, child.id] }];
  input.providers = [writeBinding(base), writeBinding(parent, { scopePath: a }), writeBinding(child, { scopePath: b })];
  const claims = principal(input); claims.grants.push(...[a, b].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  const setup = await writable({ provider: base, input, claims, host: { writers: [writer(base), writer(parent)] } });
  try {
    const ports = [a, b].map((scopePath) => setup.controller.forIdentity(setup.token, { identity: { environment: "east", scopePath }, namespace: "/alpha" }));
    for (const port of ports) await port.prepare();
    const revision = setup.reader.revision;
    assert.equal((await setup.mutations.apply(commands(input, { identity: ports[0].selection.identity, operation: "set", path: "/alpha/flag", value: "parent", layer: "scope" }))).success, true);
    assert.equal(ports[0].get(["flag"]), "parent"); assert.equal(ports[1].get(["flag"]), "parent");
    assert.equal(setup.reader.get(["flag"]), "before"); assert.equal(setup.reader.revision, revision);
    assert.equal((await setup.mutations.apply(commands(input, { identity: ports[1].selection.identity, operation: "set", path: "/alpha/flag", value: "child", layer: "scope" }))).error.code, "WRITE_UNAVAILABLE");
    assert.equal(parent.writes, 1); assert.equal(child.writes, 0);
  } finally { await setup.root.dispose(); }
});
test("remove reveals a required leaf fallback but cannot remove its last valid contribution", async () => {
  const base = new WritableMemory("base", "base", { alpha: { flag: "base" } });
  const override = new WritableMemory("override", "override", { alpha: { flag: "override" } });
  const input = writableOptions([base, override]);
  input.schemas = [registration("east", "alpha", { type: "object", required: ["flag"], properties: { flag: { type: "string" } } })];
  const setup = await writable({ provider: base, input, host: { writers: [writer(base), writer(override)] } });
  try {
    assert.equal((await setup.mutations.apply(commands(input, { operation: "remove", path: "/alpha/flag", layer: "override" }))).success, true);
    assert.equal(setup.reader.get(["flag"]), "base"); assert.equal(setup.reader.inspect(["flag"]).effectiveLayer, "base");
    const revision = setup.reader.revision;
    assert.equal((await setup.mutations.apply(commands(input, { operation: "remove", path: "/alpha/flag" }))).error.code, "VALIDATION_ERROR");
    assert.equal(setup.reader.revision, revision); assert.equal(override.removes, 1); assert.equal(base.removes, 0);
  } finally { await setup.root.dispose(); }
});
