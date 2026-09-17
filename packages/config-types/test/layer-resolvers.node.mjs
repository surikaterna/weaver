import assert from "node:assert/strict";
import { test } from "node:test";
import { Layers } from "../src/layer-factories.ts";

test("installed static/dynamic/ephemeral layer resolvers execute actual asynchronous provider IO", async () => {
  const reads = [];
  const provider = { layer: "tenant", async load() { reads.push("tenant"); return { entries: { base: true }, revision: "base" }; }, async loadLayer(layer) { reads.push(layer); return { entries: { scoped: layer }, revision: "scope" }; } };
  const fixed = Layers.Static("settings").type.createResolver(provider, {});
  assert.deepEqual(await fixed.resolve({}), [{ layerId: "tenant", data: { base: true }, revision: "base" }]);
  const dynamic = Layers.Dynamic("tenant").type.createResolver(provider, { scopes: [{ id: "tenant", label: "Tenant" }] });
  assert.deepEqual(await dynamic.resolve({ scopeInstances: new Map([["tenant", "one"]]) }), [{ layerId: "tenant", data: { base: true }, revision: "base" }, { layerId: "tenant:one", data: { scoped: "tenant:one" }, revision: "scope" }]);
  assert.deepEqual(await dynamic.resolve({}), []);
  assert.equal((await Layers.Ephemeral("session").type.createResolver(provider, {}).resolve({})).length, 1);
  assert.deepEqual(reads, ["tenant", "tenant", "tenant:one", "tenant"]);
  assert.throws(() => Layers.Personal("user").type.createResolver(provider, {}), { code: "UNSUPPORTED_AUTHORITY" });
});
