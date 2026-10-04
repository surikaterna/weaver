import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { binding, deferred, MemoryProvider, options, registration, scopeOptions } from "./fixtures/memory.mjs";

test("factory waits all loads, captures class receiver, and projects nested exact provenance without IO on reads", async () => {
  const gate = deferred();
  const base = new MemoryProvider("base", "base", { alpha: { cfg: { a: 1, b: 2 }, list: [1, 2], "literal.dot": "dot", "雪": "snow", hidden: { a: 999 }, secret: { _weaver: "secret-ref", key: "REFERENCE" }, alias: { _weaver: "mount", source: "alpha.hidden" }, unknown: "HIDDEN" } }, gate);
  const last = new MemoryProvider("last", "last", { alpha: { cfg: { a: 1, c: 3 }, list: [3], alias: { a: 999 } }, beta: { flag: "other" } });
  let ready = false;
  const pending = createConfigurationService(options([base, last])).then((root) => { ready = true; return root; });
  await Promise.resolve(); assert.equal(ready, false); assert.equal(last.loads, 1);
  gate.resolve(); const root = await pending;
  try {
    assert.deepEqual(root.get("/alpha/cfg"), { a: 1, b: 2, c: 3 });
    assert.equal(root.inspect("/alpha/cfg").effectiveLayer, undefined);
    assert.equal(root.inspect("/alpha/cfg/a").effectiveLayer, "last");
    assert.equal(root.inspect("/alpha/cfg/b").effectiveLayer, "base");
    assert.deepEqual(root.get("/alpha/list"), [3]);
    assert.equal(root.get("/alpha/literal.dot"), "dot"); assert.equal(root.get("/alpha/雪"), "snow");
    assert.equal(root.get("/beta/flag"), "other");
    assert.equal(root.get("/alpha/missing"), undefined); assert.equal(root.getWithDefault("/alpha/missing", 42), 42);
    for (const path of ["/alpha/hidden/a", "/alpha/secret/key", "/alpha/alias/a"]) {
      for (const read of [() => root.get(path), () => root.getWithDefault(path, "fallback"), () => root.getAtLayer("last", path), () => root.getNamespace(path), () => root.getForScope(path, [])]) assert.throws(read, { code: "FORBIDDEN" });
      assert.equal(root.inspect(path).effective.state, "redacted");
      assert.doesNotMatch(JSON.stringify(root.inspect(path)), /999|REFERENCE/);
    }
    for (const read of [() => root.get("/alpha/unknown"), () => root.getWithDefault("/alpha/unknown", true), () => root.inspect("/alpha/unknown"), () => root.getAtLayer("base", "/alpha/unknown"), () => root.getForScope("/alpha/unknown", []), () => root.getNamespace("/alpha/unknown")]) assert.throws(read, { code: "SCHEMA_NOT_REGISTERED" });
    assert.doesNotMatch(JSON.stringify(root.getNamespace("/alpha")), /999|REFERENCE|HIDDEN|unknown/);
    assert.equal(base.loads, 1); assert.equal(last.loads, 1); assert.equal(Object.isFrozen(base), false);
    base.entries.alpha.cfg.b = 80; assert.equal(root.get("/alpha/cfg/b"), 2);
    assert.ok(Object.isFrozen(root.get("/alpha/cfg")));
  } finally { assert.equal((await root.dispose()).ok, true); }
});

test("scope contributors occupy configured slot in identity order before later fixed overrides", async () => {
  const setup = scopeOptions();
  const child = new MemoryProvider("child", "scope", { alpha: { flag: "child", cfg: { a: 9, c: 9 } } });
  const path = [...setup.path1, { scopeId: "location", value: "site" }];
  setup.input.providers.splice(2, 0, binding(child, { environment: { kind: "environments", environments: ["east"] }, scopePath: path }));
  setup.input.layers[1].providerIds.push("child"); setup.input.identity.scopePath = path;
  const root = await createConfigurationService(setup.input);
  try {
    assert.equal(root.get("/alpha/flag"), "child"); assert.equal(root.get("/alpha/cfg/a"), 1);
    assert.deepEqual(root.inspect("/alpha/flag").contributions.map((item) => item.providerId), ["base", "first", "child", "last"]);
    assert.deepEqual(root.identity.scopePath, path);
    assert.throws(() => root.getForScope("not a path", setup.path2), { code: "SCOPE_NOT_LOADED" });
  } finally { await root.dispose(); }
});

test("explicit environment, loadLayer dialect and trusted read context are honest", async () => {
  const east = new MemoryProvider("east", "fixed", { alpha: { flag: "east" } });
  const west = new MemoryProvider("west", "fixed", { alpha: { flag: "west" } });
  const input = options([east], { identity: { environment: "west", scopePath: [] }, layers: [{ kind: "fixed", layer: "fixed", providerIds: ["east", "west"] }], providers: [binding(east, { environment: { kind: "environments", environments: ["east"] } }), binding(west, { environment: { kind: "environments", environments: ["west"] }, operation: { kind: "load-layer", layer: "dialect:west" } })] });
  let root = await createConfigurationService(input);
  assert.equal(root.get("/alpha/flag"), "west"); assert.equal(east.loads, 0); assert.equal(west.dialect, "dialect:west"); await root.dispose();
  let context;
  input.providers[1].operation = { kind: "read", read: async (received) => { context = received; return { entries: west.entries }; } };
  root = await createConfigurationService(input);
  assert.equal(context.identity.environment, "west"); assert.deepEqual(context.scopePath, []); assert.equal(context.layer, "fixed"); assert.ok(Object.isFrozen(context)); await root.dispose();
});

test("canonical registrations and recursive ceilings reject before effects", async () => {
  const provider = new MemoryProvider("p", "base", {});
  const fragment = { serviceId: "alpha", providerId: "part", environment: "east", owner: { name: "host", contact: "host@example.org" }, slotPath: "/parts", schema: { type: "object", properties: {} } };
  const service = { ...registration(), fragmentSlots: [{ slotPath: "/parts", accepts: "object" }], schema: { type: "object", properties: { parts: { type: "object", properties: {} } } } };
  for (const schemas of [[fragment, service], [service, fragment, fragment], [registration(), fragment], [service, fragment, { ...service, fragmentSlots: [] }]]) await assert.rejects(createConfigurationService(options([provider], { schemas })));
  for (const keyword of ["properties", "patternProperties", "additionalProperties", "items", "allOf", "anyOf", "oneOf", "not"]) {
    const leaf = { type: "string", "x-weaver": { maxOverrideLayer: "base" } };
    const branch = ["properties", "patternProperties"].includes(keyword) ? { [keyword]: { absent: leaf } } : { [keyword]: ["allOf", "anyOf", "oneOf"].includes(keyword) ? [leaf] : leaf };
    const schema = { type: "object", properties: { empty: { type: keyword === "items" ? "array" : "object", ...branch } } };
    await assert.rejects(createConfigurationService(options([provider], { schemas: [registration("east", "alpha", schema)] })), { code: "UNSUPPORTED_OPERATION" });
  }
  await assert.rejects(createConfigurationService(options([provider], { merge: () => ({}) })), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(provider.loads + provider.writes + provider.removes + provider.flushes, 0);
});
