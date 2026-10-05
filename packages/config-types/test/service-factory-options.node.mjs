import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationServiceOptionsSchema, configurationServiceProviderReadSchema } from "../dist/index.js";

test("native factory unions preserve opaque class receiver and readonly detached data", () => {
  class Provider { id = "p"; layer = "base"; writable = true; async load() { return { entries: {} }; } async write() { return { success: true }; } async remove() { return { success: true }; } }
  const provider = new Provider(); const input = { identity: { environment: "east", scopePath: [] }, schemas: [], layers: [{ kind: "fixed", layer: "base", providerIds: ["p"] }], providers: [{ id: "p", layer: "base", provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" } }] };
  const parsed = configurationServiceOptionsSchema.parse(input);
  assert.equal(parsed.providers[0].provider, provider); assert.equal(Object.isFrozen(provider), false);
  assert.ok(Object.isFrozen(parsed.layers)); input.layers[0].providerIds.push("other"); assert.deepEqual(parsed.layers[0].providerIds, ["p"]);
  assert.ok(configurationServiceProviderReadSchema.safeParse({ kind: "load-layer", layer: "dialect" }).success);
  assert.equal(configurationServiceProviderReadSchema.safeParse({ kind: "guess" }).success, false);
  let getters = 0; Object.defineProperty(input.identity, "environment", { get() { getters++; return "east"; } });
  assert.equal(configurationServiceOptionsSchema.safeParse(input).success, false); assert.equal(getters, 0);
});
