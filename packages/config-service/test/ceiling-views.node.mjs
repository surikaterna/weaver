import assert from "node:assert/strict";
import { test } from "node:test";
import { writable, WritableMemory, writableOptions, writer } from "./fixtures/writable-memory.mjs";
import { registration, viewSchema } from "./fixtures/memory.mjs";
import { principal } from "./fixtures/authority.mjs";

test("physical view ceilings constrain only overrides; logical ceilings preserve physical rank and base fallback", async () => {
  const low = new WritableMemory("low", "base", { alpha: { flag: "low", instances: { one: { flag: "low view" }, two: { flag: "other view" } } } });
  const high = new WritableMemory("high", "upper", { alpha: { flag: "high", instances: { one: { flag: "high view" } } } });
  const input = writableOptions([low, high]);
  const schema = viewSchema();
  schema.properties.instances.properties = { one: { type: "object", properties: { flag: { type: "string", "x-weaver": { maxOverrideLayer: "base" } } } } };
  input.schemas = [registration("east", "alpha", schema)];
  const claims = principal(input, { schemaPermissions: ["register"] });
  claims.grants.push({ ...claims.grants[0], views: ["one", "two"] });
  const s = await writable({ provider: low, input, claims, host: { writers: [writer(low), writer(high)] } });
  try {
    const view = s.reader.forView("one"), other = s.reader.forView("two");
    await view.prepare(); await other.prepare();
    assert.equal(s.reader.get(["flag"]), "high");
    assert.equal(view.get(["flag"]), "low view");
    assert.equal(other.get(["flag"]), "other view");
    assert.equal(view.inspect(["flag"]).effectiveLayer, "base");
    const admin = s.controller.forSchemas(s.token);
    const request = structuredClone(input.schemas[0]);
    request.schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
    assert.equal((await admin.register(request)).success, true);
    assert.equal(s.reader.get(["flag"]), "low");
    assert.equal(view.get(["flag"]), "low view");
    low.entries.alpha.instances.one = {};
    assert.equal((await s.root.reloadProvider(low.id)).ok, true);
    assert.equal(view.get(["flag"]), "low");
  } finally { await s.root.dispose(); }
});

test("logical descendant ceilings prevent destructive physical override before object validation", async () => {
  const low = new WritableMemory("low", "base", { alpha: { flag: "fallback" } });
  const high = new WritableMemory("high", "upper", { alpha: { instances: { one: null } } });
  const input = writableOptions([low, high]), schema = viewSchema();
  schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  input.schemas = [registration("east", "alpha", schema)];
  const claims = principal(input); claims.grants.push({ ...claims.grants[0], views: ["one"] });
  const s = await writable({ provider: low, input, claims });
  try {
    const view = s.reader.forView("one"); await view.prepare();
    assert.equal(view.get(["flag"]), "fallback");
    assert.equal(view.inspect(["flag"]).effectiveLayer, "base");
  } finally { await s.root.dispose(); }
});

test("mixed-type declared tuple ceilings survive logical and physical view mapping", async () => {
  for (const location of ["logical", "physical"]) {
    const low = new WritableMemory("low", "base", { alpha: { list: {}, instances: { one: { list: {} } } } });
    const high = new WritableMemory("high", "upper", { alpha: { instances: { one: { list: null } } } });
    const input = writableOptions([low, high]), schema = viewSchema();
    const list = { type: ["object", "array", "null"], additionalProperties: true, items: [{ type: "number" }] };
    schema.properties.list = structuredClone(list);
    schema.properties.instances.additionalProperties.properties.list = structuredClone(list);
    const target = location === "logical" ? schema.properties.list : schema.properties.instances.additionalProperties.properties.list;
    target.items[0]["x-weaver"] = { maxOverrideLayer: "base" };
    input.schemas = [registration("east", "alpha", schema)];
    const claims = principal(input); claims.grants.push({ ...claims.grants[0], views: ["one"] });
    const s = await writable({ provider: low, input, claims });
    try {
      const view = s.reader.forView("one"); await view.prepare();
      assert.deepEqual(view.get(["list"]), {});
      assert.deepEqual(s.reader.get(["list"]), {});
    } finally { await s.root.dispose(); }
  }
});
