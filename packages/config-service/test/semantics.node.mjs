import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { binding, MemoryProvider, options, registration, scopeOptions } from "./fixtures/memory.mjs";

test("canonical undefined skip, null/primitive reset, object restart and atomic arrays keep engine winners", async () => {
  for (const [middle, last, value, layer] of [[undefined, undefined, { a: 1, b: 2 }, "base"], [null, undefined, null, "middle"], [7, undefined, 7, "middle"], [null, { c: 3 }, { c: 3 }, "last"]]) {
    const base = new MemoryProvider("base", "base", { alpha: { cfg: { a: 1, b: 2 }, list: [1, 2] } });
    const mid = new MemoryProvider("mid", "middle", { alpha: { cfg: middle, list: [] } });
    const final = new MemoryProvider("last", "last", { alpha: { cfg: last, list: undefined } });
    const root = await createConfigurationService(options([base, mid, final]));
    try {
      assert.deepEqual(root.get("/alpha/cfg"), value); assert.equal(root.inspect("/alpha/cfg").effectiveLayer, layer);
      assert.deepEqual(root.get("/alpha/list"), []); assert.equal(root.inspect("/alpha/list").effectiveLayer, "middle");
    } finally { await root.dispose(); }
  }
});

test("tuple-safe identities detach borrower scopes, cold errors precede paths, failed preload does not release live providers", async () => {
  const setup = scopeOptions({ firstFails: true }); let disposals = 0;
  setup.input.providers[1].ownership = { kind: "owned", dispose: () => { disposals++; } };
  const root = await createConfigurationService(setup.input);
  try {
    const path = setup.path2.map((scope) => ({ ...scope })); const pending = root.preloadScope(path); path[0].value = "mutated"; await pending;
    assert.equal(root.getForScope("/alpha/flag", setup.path2), "two");
    assert.throws(() => root.getForScope("invalid", path), { code: "SCOPE_NOT_LOADED" });
    await assert.rejects(root.preloadScope(setup.path1), { code: "SERVER_DEGRADED" }); assert.equal(disposals, 0);
    let getters = 0; const dangerous = [{ get scopeId() { getters++; return "area"; }, value: "value" }];
    await assert.rejects(root.preloadScope(dangerous), { code: "VALIDATION_ERROR" }); assert.equal(getters, 0);
    assert.throws(() => root.onChange("/alpha/hidden", () => {}), { code: "FORBIDDEN" });
    assert.throws(() => root.onChange("/alpha/not-declared", () => {}), { code: "SCHEMA_NOT_REGISTERED" });
  } finally { await root.dispose(); }
  assert.equal(disposals, 1);
});

test("common vs explicit environments cannot ambiguously relabel fixed data; nested custom policy rejects before hooks", async () => {
  const a = new MemoryProvider("a", "base", {}), b = new MemoryProvider("b", "base", {}); let callbacks = 0;
  const input = options([a], { layers: [{ kind: "fixed", layer: "base", providerIds: ["a", "b"] }], providers: [binding(a), binding(b, { environment: { kind: "environments", environments: ["west"] } })] });
  await assert.rejects(createConfigurationService(input), { code: "VALIDATION_ERROR" });
  const policy = options([a]); policy.layers[0].strategy = "custom"; policy.providers[0].ownership = { kind: "owned", dispose: () => { callbacks++; } };
  await assert.rejects(createConfigurationService(policy), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(callbacks + a.loads + b.loads, 0);
});

test("schema graph ceilings do not recurse into literal defaults, but unselected environments still reject metadata", async () => {
  const provider = new MemoryProvider("p", "base", {});
  const literal = registration("east", "alpha", { type: "object", properties: { literal: { type: "object", default: { "x-weaver": { maxOverrideLayer: "base" } }, properties: {} } } });
  const root = await createConfigurationService(options([provider], { schemas: [literal] })); await root.dispose();
  const ceiling = registration("west", "beta", { type: "object", properties: { absent: { type: "string", "x-weaver": { maxOverrideLayer: "base" } } } });
  await assert.rejects(createConfigurationService(options([provider], { schemas: [registration(), ceiling] })), { code: "UNSUPPORTED_OPERATION" }); assert.equal(provider.loads, 1);
});

test("factory isolates registration input and captures future scope methods without freezing opaque provider", async () => {
  const setup = scopeOptions();
  const root = await createConfigurationService(setup.input);
  try {
    setup.input.schemas[0].schema.properties.hidden["x-weaver"].sensitive = false;
    setup.input.layers.reverse();
    setup.first.load = async () => { throw Error("replaced method"); };
    await root.preloadScope(setup.path1);
    assert.equal(root.getForScope("/alpha/flag", setup.path1), "one"); assert.equal(setup.first.loads, 1);
    assert.throws(() => root.get("/alpha/hidden"), { code: "FORBIDDEN" });
    assert.equal(Object.isFrozen(setup.first), false); assert.equal(Object.isFrozen(setup.input), false);
  } finally { await root.dispose(); }
});
