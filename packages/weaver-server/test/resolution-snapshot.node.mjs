import assert from "node:assert/strict";
import { test } from "node:test";
import { deepMerge } from "@weaver-conf/config-engine";
import { inspectPublicConfig } from "../src/core/public-config-inspection.ts";
import { createConfigStateReader } from "../src/core/config-service-state.ts";

test("server inspection returns merged values and operation origins without changing raw breakdown", () => {
  const layers = [
    { layer: "core", entries: { cfg: { a: 1, b: 2 }, array: [1] } },
    { layer: "user", entries: { cfg: { a: 1, c: 3 }, array: [] } },
  ];
  const object = inspectPublicConfig("cfg", layers);
  assert.deepEqual(object.effectiveValue, { a: 1, b: 2, c: 3 });
  assert.equal(object.effectiveLayer, undefined);
  assert.deepEqual(object.layerValues, { core: { a: 1, b: 2 }, user: { a: 1, c: 3 } });
  assert.equal(inspectPublicConfig("cfg.a", layers).effectiveLayer, "user");
  assert.equal(inspectPublicConfig("cfg.b", layers).effectiveLayer, "core");
  assert.equal(inspectPublicConfig("array", layers).effectiveLayer, "user");
});

test("state adapter retains fixed-before-scope ordering and independently merged scope grouping", () => {
  const providers = [{ id: "base", layer: "user" }, { id: "scope1", layer: "tenant:t" }, { id: "scope2", layer: "site:s" }];
  const data = new Map([
    ["base", { cfg: { a: 1, b: 2 } }],
    ["scope1", { cfg: null }],
    ["scope2", { cfg: { a: undefined, c: 3 } }],
  ]);
  const reader = createConfigStateReader(providers, data, new Map());
  const path = [{ scopeId: "tenant", value: "t" }, { scopeId: "site", value: "s" }];
  const scopes = deepMerge(data.get("scope1"), data.get("scope2"));
  assert.deepEqual(reader.getMergedState(path), deepMerge(data.get("base"), scopes));
  assert.deepEqual(reader.getMergedState(path), { cfg: { a: 1, b: 2, c: 3 } });
});

test("protected config and tainted mount inspection remain omitted", () => {
  const layers = [{ layer: "core", entries: { _weaver: { registry: { secret: "hidden" } }, alias: { _weaver: "mount", source: "_weaver.registry.secret" } } }];
  assert.equal(inspectPublicConfig("_weaver.registry.secret", layers).effectiveValue, undefined);
  assert.equal(inspectPublicConfig("alias", layers).effectiveValue, undefined);
});
