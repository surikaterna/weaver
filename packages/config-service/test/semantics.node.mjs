import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { hostedReader, readonlyHost } from "./fixtures/authority.mjs";
import { binding, MemoryProvider, options, registration, scopeOptions } from "./fixtures/memory.mjs";

test("canonical undefined skip, null/primitive reset, object restart and atomic arrays keep engine winners", async () => {
  for (const [middle, last, value, layer] of [[undefined, undefined, { a: 1, b: 2 }, "base"], [null, undefined, null, "middle"], [7, undefined, 7, "middle"], [null, { c: 3 }, { c: 3 }, "last"]]) {
    const base = new MemoryProvider("base", "base", { alpha: { cfg: { a: 1, b: 2 }, list: [1, 2] } });
    const mid = new MemoryProvider("mid", "middle", { alpha: { cfg: middle, list: [] } });
    const final = new MemoryProvider("last", "last", { alpha: { cfg: last, list: undefined } });
    const { root, reader } = await hostedReader(options([base, mid, final]));
    try {
      assert.deepEqual(reader.get(["cfg"]), value); assert.equal(reader.inspect(["cfg"]).effectiveLayer, layer);
      assert.deepEqual(reader.get(["list"]), []); assert.equal(reader.inspect(["list"]).effectiveLayer, "middle");
    } finally { await root.dispose(); }
  }
});

test("tuple-safe identities detach borrower scopes, cold reads and failed preparation do not release live providers", async () => {
  const setup = scopeOptions({ firstFails: true }); let disposals = 0;
  setup.input.providers[1].ownership = { kind: "owned", dispose: () => { disposals++; } };
  const { root, reader } = await hostedReader(setup.input);
  try {
    const path = setup.path2.map((scope) => ({ ...scope })); const selected = reader.withScope(path);
    const pending = selected.prepare(); path[0].value = "mutated"; await pending;
    assert.equal(selected.get(["flag"]), "two");
    assert.deepEqual(selected.selection.identity.scopePath, setup.path2);
    assert.throws(() => reader.withScope(path), { code: "FORBIDDEN" });
    const failed = reader.withScope(setup.path1);
    assert.throws(() => failed.get(["flag"]), { code: "SCOPE_NOT_LOADED" });
    await assert.rejects(failed.prepare(), { code: "SERVER_DEGRADED" }); assert.equal(disposals, 0);
    let getters = 0; const dangerous = [{ get scopeId() { getters++; return "area"; }, value: "value" }];
    assert.throws(() => reader.withScope(dangerous), { code: "FORBIDDEN" }); assert.equal(getters, 0);
    assert.throws(() => reader.onChange(["hidden"], () => {}), { code: "FORBIDDEN" });
    assert.throws(() => reader.onChange(["not-declared"], () => {}), { code: "SCHEMA_NOT_REGISTERED" });
  } finally { await root.dispose(); }
  assert.equal(disposals, 1);
});

test("common vs explicit environments cannot ambiguously relabel fixed data; nested custom policy rejects before hooks", async () => {
  const a = new MemoryProvider("a", "base", {}), b = new MemoryProvider("b", "base", {}); let callbacks = 0;
  const input = options([a], { layers: [{ kind: "fixed", layer: "base", providerIds: ["a", "b"] }], providers: [binding(a), binding(b, { environment: { kind: "environments", environments: ["west"] } })] });
  const host = readonlyHost(input);
  await assert.rejects(createConfigurationService(input, host), { code: "VALIDATION_ERROR" });
  const policy = options([a]); policy.layers[0].strategy = "custom"; policy.providers[0].ownership = { kind: "owned", dispose: () => { callbacks++; } };
  await assert.rejects(createConfigurationService(policy, host), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(callbacks + a.loads + b.loads, 0);
});

test("schema graph ceilings do not recurse into literal defaults, but unselected environments still reject metadata", async () => {
  const provider = new MemoryProvider("p", "base", {});
  const literal = registration("east", "alpha", { type: "object", properties: { literal: { type: "object", default: { "x-weaver": { maxOverrideLayer: "base" } }, properties: {} } } });
  const host = readonlyHost(options([provider]));
  const root = await createConfigurationService(options([provider], { schemas: [literal] }), host); await root.dispose();
  const ceiling = registration("west", "beta", { type: "object", properties: { absent: { type: "string", "x-weaver": { maxOverrideLayer: "base" } } } });
  await assert.rejects(createConfigurationService(options([provider], { schemas: [registration(), ceiling] }), host), { code: "UNSUPPORTED_OPERATION" }); assert.equal(provider.loads, 1);
});

test("factory isolates registration input and captures future scope methods without freezing opaque provider", async () => {
  const setup = scopeOptions();
  const { root, reader } = await hostedReader(setup.input);
  try {
    setup.input.schemas[0].schema.properties.hidden["x-weaver"].sensitive = false;
    setup.input.layers.reverse();
    setup.first.load = async () => { throw Error("replaced method"); };
    const selected = reader.withScope(setup.path1); await selected.prepare();
    assert.equal(selected.get(["flag"]), "one"); assert.equal(setup.first.loads, 1);
    assert.throws(() => reader.get(["hidden"]), { code: "FORBIDDEN" });
    assert.equal(Object.isFrozen(setup.first), false); assert.equal(Object.isFrozen(setup.input), false);
  } finally { await root.dispose(); }
});
