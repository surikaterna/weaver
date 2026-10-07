import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { hostedReader, readonlyHost } from "./fixtures/authority.mjs";
import { binding, deferred, MemoryProvider, options, registration, scopeOptions } from "./fixtures/memory.mjs";

test("factory waits all loads, captures class receiver, and projects nested exact provenance without IO on reads", async () => {
  const gate = deferred();
  const base = new MemoryProvider("base", "base", { alpha: { cfg: { a: 1, b: 2 }, list: [1, 2], "literal.dot": "dot", "雪": "snow", hidden: { a: 999 }, secret: { _weaver: "secret-ref", key: "REFERENCE" }, alias: { _weaver: "mount", source: "alpha.hidden" }, unknown: "HIDDEN" } }, gate);
  const last = new MemoryProvider("last", "last", { alpha: { cfg: { a: 1, c: 3 }, list: [3], alias: { a: 999 } }, beta: { flag: "other" } });
  let ready = false;
  const pending = hostedReader(options([base, last]), "/").then((setup) => { ready = true; return setup; });
  await Promise.resolve(); assert.equal(ready, false); assert.equal(last.loads, 1);
  gate.resolve(); const { root, reader } = await pending;
  try {
    assert.deepEqual(reader.get(["alpha", "cfg"]), { a: 1, b: 2, c: 3 });
    assert.equal(reader.inspect(["alpha", "cfg"]).effectiveLayer, undefined);
    assert.equal(reader.inspect(["alpha", "cfg", "a"]).effectiveLayer, "last");
    assert.equal(reader.inspect(["alpha", "cfg", "b"]).effectiveLayer, "base");
    assert.deepEqual(reader.get(["alpha", "list"]), [3]);
    assert.equal(reader.get(["alpha", "literal.dot"]), "dot"); assert.equal(reader.get(["alpha", "雪"]), "snow");
    assert.equal(reader.get(["beta", "flag"]), "other");
    assert.equal(reader.get(["alpha", "missing"]), undefined); assert.equal(reader.get(["alpha", "missing"], { defaultValue: 42 }), 42);
    for (const path of [["alpha", "hidden", "a"], ["alpha", "secret", "key"], ["alpha", "alias", "a"]]) {
      for (const read of [() => reader.get(path), () => reader.get(path, { defaultValue: "fallback" }), () => reader.get(path, { layer: "last" }), () => reader.snapshot(path), () => reader.withScope([]).get(path)]) assert.throws(read, { code: "FORBIDDEN" });
      assert.equal(reader.inspect(path).effective.state, "redacted");
      assert.doesNotMatch(JSON.stringify(reader.inspect(path)), /999|REFERENCE/);
    }
    for (const read of [() => reader.get(["alpha", "unknown"]), () => reader.get(["alpha", "unknown"], { defaultValue: true }), () => reader.inspect(["alpha", "unknown"]), () => reader.get(["alpha", "unknown"], { layer: "base" }), () => reader.withScope([]).get(["alpha", "unknown"]), () => reader.snapshot(["alpha", "unknown"])]) assert.throws(read, { code: "SCHEMA_NOT_REGISTERED" });
    assert.doesNotMatch(JSON.stringify(reader.get(["alpha"])), /999|REFERENCE|HIDDEN|unknown/);
    assert.equal(base.loads, 1); assert.equal(last.loads, 1); assert.equal(Object.isFrozen(base), false);
    base.entries.alpha.cfg.b = 80; assert.equal(reader.get(["alpha", "cfg", "b"]), 2);
    assert.ok(Object.isFrozen(reader.get(["alpha", "cfg"])));
  } finally { assert.equal((await root.dispose()).ok, true); }
});

test("scope contributors occupy configured slot in identity order before later fixed overrides", async () => {
  const setup = scopeOptions();
  const child = new MemoryProvider("child", "scope", { alpha: { flag: "child", cfg: { a: 9, c: 9 } } });
  const path = [...setup.path1, { scopeId: "location", value: "site" }];
  setup.input.providers.splice(2, 0, binding(child, { environment: { kind: "environments", environments: ["east"] }, scopePath: path }));
  setup.input.layers[1].providerIds.push("child"); setup.input.identity.scopePath = path;
  const { root, reader } = await hostedReader(setup.input);
  try {
    assert.equal(reader.get(["flag"]), "child"); assert.equal(reader.get(["cfg", "a"]), 1);
    assert.deepEqual(reader.inspect(["flag"]).contributions.map((item) => item.providerId), ["base", "first", "child", "last"]);
    assert.deepEqual(reader.selection.identity.scopePath, path);
    assert.throws(() => reader.withScope(setup.path2).get(["flag"]), { code: "SCOPE_NOT_LOADED" });
  } finally { await root.dispose(); }
});

test("explicit environment, loadLayer dialect and trusted read context are honest", async () => {
  const east = new MemoryProvider("east", "fixed", { alpha: { flag: "east" } });
  const west = new MemoryProvider("west", "fixed", { alpha: { flag: "west" } });
  const input = options([east], { identity: { environment: "west", scopePath: [] }, layers: [{ kind: "fixed", layer: "fixed", providerIds: ["east", "west"] }], providers: [binding(east, { environment: { kind: "environments", environments: ["east"] } }), binding(west, { environment: { kind: "environments", environments: ["west"] }, operation: { kind: "load-layer", layer: "dialect:west" } })] });
  const { root, reader } = await hostedReader(input);
  assert.equal(reader.get(["flag"]), "west"); assert.equal(east.loads, 0); assert.equal(west.dialect, "dialect:west"); await root.dispose();
  let context;
  input.providers[1].operation = { kind: "read", read: async (received) => { context = received; return { entries: west.entries }; } };
  const next = await hostedReader(input);
  assert.equal(context.identity.environment, "west"); assert.deepEqual(context.scopePath, []); assert.equal(context.layer, "fixed"); assert.ok(Object.isFrozen(context)); await next.root.dispose();
});

test("canonical registrations and recursive ceilings reject before effects", async () => {
  const provider = new MemoryProvider("p", "base", {});
  const fragment = { serviceId: "alpha", providerId: "part", environment: "east", owner: { name: "host", contact: "host@example.org" }, slotPath: "/parts", schema: { type: "object", properties: {} } };
  const service = { ...registration(), fragmentSlots: [{ slotPath: "/parts", accepts: "object" }], schema: { type: "object", properties: { parts: { type: "object", properties: {} } } } };
  const host = readonlyHost(options([provider]));
  for (const schemas of [[fragment, service], [service, fragment, fragment], [registration(), fragment], [service, fragment, { ...service, fragmentSlots: [] }]]) await assert.rejects(createConfigurationService(options([provider], { schemas }), host));
  for (const keyword of ["properties", "patternProperties", "additionalProperties", "items", "allOf", "anyOf", "oneOf", "not"]) {
    const leaf = { type: "string", "x-weaver": { maxOverrideLayer: "base" } };
    const branch = ["properties", "patternProperties"].includes(keyword) ? { [keyword]: { absent: leaf } } : { [keyword]: ["allOf", "anyOf", "oneOf"].includes(keyword) ? [leaf] : leaf };
    const schema = { type: "object", properties: { empty: { type: keyword === "items" ? "array" : "object", ...branch } } };
    await assert.rejects(createConfigurationService(options([provider], { schemas: [registration("east", "alpha", schema)] }), host), { code: "UNSUPPORTED_OPERATION" });
  }
  await assert.rejects(createConfigurationService(options([provider], { merge: () => ({}) }), host), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(provider.loads + provider.writes + provider.removes + provider.flushes, 0);
});
