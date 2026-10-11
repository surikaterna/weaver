import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { hostedReader, readonlyHost } from "./fixtures/authority.mjs";
import { MemoryProvider, options } from "./fixtures/memory.mjs";

test("own input descriptors, cycles and exotic provider data reject without getters or borrowed freeze", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "ok" } }); let getters = 0;
  const host = readonlyHost(options([provider]));
  for (const key of ["identity", "schemas", "providers", "layers"]) {
    const input = options([provider]); Object.defineProperty(input, key, { get() { getters++; return []; } });
    await assert.rejects(createConfigurationService(input, host), { code: "VALIDATION_ERROR" });
  }
  const input = options([provider]); Object.defineProperty(input.schemas[0].schema.properties.flag, "type", { get() { getters++; return "string"; } });
  await assert.rejects(createConfigurationService(input, host), { code: "VALIDATION_ERROR" });
  const capability = new MemoryProvider("c", "base", {}); Object.defineProperty(capability, "load", { get() { getters++; return async () => ({ entries: {} }); } });
  await assert.rejects(createConfigurationService(options([capability]), host), { code: "VALIDATION_ERROR" });
  for (const key of ["0", "1", "700"]) {
    const input = options([provider]); Object.defineProperty(input.schemas, key, { get() { getters++; return input.schemas[0]; }, configurable: true });
    await assert.rejects(createConfigurationService(input, host), { code: "VALIDATION_ERROR" });
  }
  assert.equal(getters, 0); assert.equal(provider.loads, 0);
  for (const entries of [{ alpha: new Date() }, (() => { const value = {}; value.self = value; return value; })(), { get alpha() { getters++; return {}; } }]) {
    const bad = new MemoryProvider("b", "base", entries); await assert.rejects(createConfigurationService(options([bad]), host), { code: "SERVER_DEGRADED" });
  }
  assert.equal(getters, 0);
  const shared = { a: 1 }; provider.entries = { alpha: { cfg: shared }, beta: { cfg: shared }, ...JSON.parse('{"__proto__":{"inert":true}}') };
  const { root, reader } = await hostedReader(options([provider])); assert.equal(reader.get(["cfg", "a"]), 1); assert.equal(Object.isFrozen(shared), false); await root.dispose();
});

test("duplicates, empty selectors, unused/ambiguous bindings and missing selected dialect reject before IO", async () => {
  const provider = new MemoryProvider("p", "base", {});
  for (const mutate of [
    (input) => input.layers.push(input.layers[0]),
    (input) => input.providers.push(input.providers[0]),
    (input) => input.providers[0].environment = { kind: "environments", environments: ["east", "east"] },
    (input) => input.providers[0].environment = { kind: "environments", environments: [] },
    (input) => input.layers[0].providerIds = ["missing"],
    (input) => input.providers[0].id = "different",
    (input) => input.providers[0].operation = { kind: "load-layer", layer: "other" },
  ]) {
    const input = options([provider]);
    const host = readonlyHost(input);
    mutate(input);
    if (input.providers[0].operation.kind === "load-layer") { provider.loadLayer = undefined; }
    await assert.rejects(createConfigurationService(input, host));
  }
  assert.equal(provider.loads, 0);
});

async function rejectProviderContainer(mutate) {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "PRIVATE_PROVIDER_ROW" } });
  let reads = 0, disposals = 0, getters = 0, escaped;
  Object.defineProperty(provider, "opaque", { get() { getters++; return "PRIVATE_PROVIDER_ROW"; }, configurable: true });
  const input = options([provider]);
  const host = readonlyHost(input);
  input.providers[0].operation = { kind: "read", read: async () => { reads++; return provider.load(); } };
  input.providers[0].ownership = { kind: "owned", dispose: () => { disposals++; } };
  mutate(input.providers);
  const descriptors = Object.getOwnPropertyDescriptors(input.providers);
  const prototype = Object.getPrototypeOf(input.providers);
  const pending = createConfigurationService(input, host).then((root) => { escaped = root; return root; });
  try {
    await assert.rejects(pending, (error) => error.code === "VALIDATION_ERROR" && !error.message.includes("PRIVATE_PROVIDER_ROW"));
  } finally {
    if (escaped) await escaped.dispose();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(input.providers), descriptors);
  assert.equal(Object.getPrototypeOf(input.providers), prototype);
  assert.equal(input.providers[0].provider, provider);
  assert.equal(Object.isFrozen(provider), false);
  assert.deepEqual([provider.loads, reads, provider.writes, provider.removes, provider.flushes, disposals, getters], [0, 0, 0, 0, 0, 0, 0]);
}

test("hidden numeric provider data rows reject before reads and owned resource acquisition", async () => {
  await rejectProviderContainer((rows) => Object.defineProperty(rows, "0", { enumerable: false }));
});

test("caller-owned exotic provider arrays reject while frozen ordinary arrays retain opaque class receivers", async () => {
  class Exotic extends Array {}
  for (const prototype of [Exotic.prototype, Object.create(Array.prototype), null])
    await rejectProviderContainer((rows) => Object.setPrototypeOf(rows, prototype));
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "accepted" } });
  const input = options([provider]); let disposals = 0;
  input.providers[0].ownership = { kind: "owned", dispose: () => { disposals++; } };
  Object.freeze(input.providers);
  const descriptors = Object.getOwnPropertyDescriptors(input.providers);
  const { root, reader } = await hostedReader(input);
  try {
    assert.equal(reader.get(["flag"]), "accepted"); assert.equal(provider.loads, 1);
    assert.deepEqual(Object.getOwnPropertyDescriptors(input.providers), descriptors);
    assert.equal(Object.getPrototypeOf(input.providers), Array.prototype);
    assert.equal(input.providers[0].provider, provider); assert.equal(Object.isFrozen(provider), false);
  } finally { await root.dispose(); }
  assert.equal(disposals, 1);
});
