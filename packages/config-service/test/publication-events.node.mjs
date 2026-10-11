import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationReaderChangeSchema } from "@weaver-conf/config-types";
import { commands, writable, WritableMemory, writableOptions, writer } from "./fixtures/writable-memory.mjs";
import { principal } from "./fixtures/authority.mjs";
import { registration, viewSchema } from "./fixtures/memory.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";

test("one immutable publication per batch, semantic no-op suppression and callback reentry", async () => {
  const setup = await writable();
  const { root, reader, mutations, input } = setup;
  const events = [], failures = [];
  try {
    reader.onChange([], () => { throw Error("observer"); });
    reader.onChange([], async () => { throw Error("async observer"); });
    reader.onChange([], event => {
      assert.equal(configurationReaderChangeSchema.safeParse(event).success, true);
      events.push(event);
      assert.deepEqual(reader.get(), event.current.value);
    });
    assert.equal(events.length, 0);
    const apply = async (...items) => {
      const result = await mutations.apply(commands(input, ...items));
      await Promise.resolve();
      return result;
    };
    assert.equal((await apply({ operation: "set", path: "/alpha/flag", value: "next" },
      { operation: "set", path: "/alpha/cfg/a", value: 2 })).success, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "effective");
    assert.equal(events[0].cause, "mutation");
    assert.equal(events[0].previous.value.flag, "before");
    assert.equal(events[0].current.value.flag, "next");
    assert.equal(Object.isFrozen(events[0].current.value), true);
    await apply({ operation: "set", path: "/alpha/flag", value: "next" });
    assert.equal(events.length, 1);
    let followup;
    const release = reader.onChange(["flag"], event => {
      if (event.current.value === "trigger") followup = apply({ operation: "set", path: "/alpha/flag", value: "reentrant" });
    });
    await apply({ operation: "set", path: "/alpha/flag", value: "trigger" });
    assert.equal((await followup).success, true);
    assert.equal(reader.get(["flag"]), "reentrant");
    release();
    assert.deepEqual(failures, []);
  } finally { await root.dispose(); }
});

async function layerOnlyFixture(effective = false) {
  const low = new WritableMemory(), high = new WritableMemory("high", "high", { alpha: { flag: "winner" } });
  const input = writableOptions([low, high]), permissions = { effective, read: true, inspect: true }, seen = [];
  const setup = await writable({ provider: low, input, host: { hostAuthority: {
    authorizeReadSync(_actor, request) {
      seen.push({ operation: request.operation, layer: request.layer });
      return (request.layer === "base" ? permissions[request.operation] : permissions.effective) ? "allowed" : "denied";
    }, authorizeWrite: async (_actor, request) => request.operation === "schema-register" ? "allowed" : "denied",
  } } });
  const reload = async value => {
    low.entries.alpha.flag = value;
    assert.equal((await setup.root.reloadProvider(low.id)).ok, true);
    await Promise.resolve();
  };
  return { ...setup, low, high, permissions, seen, reload };
}

test("explicit layer registration needs selected read and inspect, not effective authority", async () => {
  const { root, reader, low, high, seen, reload } = await layerOnlyFixture();
  try {
    assert.equal(reader.get(["flag"], { layer: "base" }), "before");
    assert.throws(() => reader.onChange(["flag"], () => {}), { code: "FORBIDDEN" });
    seen.length = 0;
    const events = [];
    reader.onChange(["flag"], event => events.push(event), { layer: "base" });
    assert.equal(low.loads, 1); assert.equal(high.loads, 1);
    assert.ok(seen.some(request => request.operation === "read"));
    assert.ok(seen.some(request => request.operation === "inspect"));
    await reload("lower-new");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "layer");
    assert.equal(events[0].previous[0].value, "before");
    assert.equal(events[0].current[0].value, "lower-new");
    assert.ok(seen.every(request => request.layer === "base"));
    assert.equal(root.restartState.pending, "none");
    assert.equal("reloadBehavior" in events[0], false);
    assert.equal(high.entries.alpha.flag, "winner");
  } finally { await root.dispose(); }
});

test("explicit layer delivery rechecks its two permissions independently of later effective denial", async () => {
  const { root, reader, permissions, seen, reload } = await layerOnlyFixture(true);
  try {
    const events = [], effective = [];
    reader.onChange(["flag"], event => effective.push(event));
    reader.onChange(["flag"], event => events.push(event), { layer: "base" });
    permissions.effective = false;
    await reload("lower-new");
    assert.equal(events.length, 1); assert.equal(effective.length, 0);
    for (const permission of ["read", "inspect"]) {
      permissions[permission] = false;
      assert.throws(() => reader.onChange(["flag"], () => {}, { layer: "base" }), { code: "FORBIDDEN" });
      await reload(`denied-${permission}`);
      assert.equal(events.length, permission === "read" ? 1 : 2);
      permissions[permission] = true;
      await reload(`restored-${permission}`);
      assert.equal(events.at(-1).previous[0].value, `denied-${permission}`);
      assert.equal(events.at(-1).current[0].value, `restored-${permission}`);
    }
    assert.equal(events.length, 3); assert.equal(effective.length, 0);
    assert.equal(root.restartState.pending, "none");
    seen.length = 0;
    reader.dispose();
    assert.throws(() => reader.onChange(["flag"], () => {}, { get layer() { throw Error("must not read options"); } }), { code: "DISPOSED" });
    assert.deepEqual(seen, []);
  } finally { await root.dispose(); }
});

test("explicit layer schema invalidation uses current layer selection and forbids newly sensitive direct paths", async () => {
  const { root, reader, controller, input, seen } = await layerOnlyFixture();
  try {
    const aggregate = [], direct = [];
    reader.onChange([], event => aggregate.push(event), { layer: "base" });
    reader.onChange(["flag"], event => direct.push(event), { layer: "base" });
    const admin = controller.forSchemas(controller.mint(schemaClaims(input)));
    const request = structuredClone(input.schemas[0]);
    request.schema.properties.flag["x-weaver"] = { sensitive: true };
    seen.length = 0;
    assert.equal((await admin.register(request)).success, true);
    await Promise.resolve();
    assert.equal(aggregate.length, 1); assert.equal(direct.length, 0);
    assert.equal(aggregate[0].kind, "invalidation");
    assert.equal(aggregate[0].reason, "schema");
    assert.equal("previous" in aggregate[0], false); assert.equal("current" in aggregate[0], false);
    assert.ok(seen.every(request => request.layer === "base"));
    assert.throws(() => reader.get(["flag"], { layer: "base" }), { code: "FORBIDDEN" });
    assert.equal(root.restartState.pending, "none");
  } finally { await root.dispose(); }
});

test("selected view reset publishes original override to actual base fallback with source-aware layer evidence", async () => {
  const provider = new WritableMemory("disk", "base", { alpha: { flag: "base", instances: { one: { flag: "override" } } } });
  const input = writableOptions([provider]); input.schemas = [registration("east", "alpha", viewSchema())];
  const claims = principal(input); claims.grants[0].sensitive = true; claims.grants.push({ ...claims.grants[0], views: ["one"] });
  const { root, reader, mutations } = await writable({ provider, input, claims });
  try {
    const view = reader.forView("one"); await view.prepare();
    const base = [], effective = [], layer = [];
    reader.onChange(["flag"], event => base.push(event));
    view.onChange(["flag"], event => effective.push(event));
    view.onChange(["flag"], event => layer.push(event), { layer: "base" });
    const result = await mutations.apply(commands(input, { operation: "remove", path: "/alpha", viewId: "one" }));
    await Promise.resolve();
    assert.equal(result.success, true);
    assert.equal(base.length, 0); assert.equal(effective.length, 1); assert.equal(layer.length, 1);
    assert.equal(effective[0].previous.value, "override"); assert.equal(effective[0].current.value, "base");
    assert.equal(effective[0].selection.viewId, "one");
    assert.deepEqual(layer[0].previous.map(item => [item.source, item.state]), [["base", "value"], ["view", "value"]]);
    assert.deepEqual(layer[0].current.map(item => [item.source, item.state]), [["base", "value"], ["view", "missing"]]);
  } finally { await root.dispose(); }
});

test("confirmed partial prefix and uncertain observed readback have distinct honest causes", async () => {
  for (const outcome of ["partial", "unknown"]) {
    const provider = new WritableMemory(), write = provider.write;
    provider.write = async function (key, value) {
      if (value === "stop" && outcome === "partial") return { success: false };
      const result = await write.call(this, key, value);
      if (outcome === "unknown") throw Error("uncertain");
      return result;
    };
    const { root, reader, mutations, input } = await writable({ provider,
      host: { writers: [writer(provider, { failureSemantics: "rejected-means-no-effect" })] } });
    try {
      const events = []; reader.onChange(["flag"], event => events.push(event));
      const result = await mutations.apply(commands(input,
        { operation: "set", path: "/alpha/flag", value: "first" },
        { operation: "set", path: "/alpha/flag", value: "stop" }));
      await Promise.resolve();
      assert.equal(result.outcome, outcome); assert.equal(events.length, 1);
      assert.equal(events[0].current.value, "first");
      assert.equal(events[0].cause, outcome === "unknown" ? "reconcile" : "mutation");
      if (outcome === "unknown") {
        provider.entries.alpha.flag = "observed";
        assert.equal((await root.reloadProvider(provider.id)).ok, true);
        assert.equal(reader.get(["flag"]), "observed");
        assert.equal(root.mode, "degraded");
        assert.equal((await root.acknowledgeRestart(root.restartState.revision)).error.code, "WRITE_UNAVAILABLE");
        assert.equal((await mutations.apply(commands(input, { operation: "remove", path: "/alpha/flag" }))).error.code, "WRITE_UNAVAILABLE");
      }
    } finally { await root.dispose(); }
  }
});

test("shadowed raw layer changes use an explicit layer subscription and no restart", async () => {
  const low = new WritableMemory(), high = new WritableMemory("high", "high", { alpha: { flag: "winner" } });
  const input = writableOptions([low, high]);
  const { root, reader, mutations } = await writable({ provider: low, input, host: { writers: [writer(low), writer(high)] } });
  try {
    const effective = [], layer = [];
    reader.onChange(["flag"], event => effective.push(event));
    reader.onChange(["flag"], event => layer.push(event), { layer: "base" });
    assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "lower" }))).success, true);
    await Promise.resolve();
    assert.equal(effective.length, 0);
    assert.equal(layer.length, 1);
    assert.equal(layer[0].kind, "layer");
    assert.equal(layer[0].previous[0].value, "before");
    assert.equal(layer[0].current[0].value, "lower");
    assert.equal(root.restartState.pending, "none");
  } finally { await root.dispose(); }
});
