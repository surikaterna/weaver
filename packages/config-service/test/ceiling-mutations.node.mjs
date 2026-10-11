import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionHost } from "./fixtures/session-host.mjs";
import { commands, writable, WritableMemory, writableOptions, writer } from "./fixtures/writable-memory.mjs";

test("branch switching cannot expose a sibling protected by the before-branch ceiling", async () => {
  for (const keyword of ["anyOf", "oneOf"]) {
    const provider = new WritableMemory("disk", "upper", { alpha: { kind: "locked", value: 9 } });
    const input = writableOptions([provider]);
    input.layers.unshift({ kind: "session", layer: "incident" });
    const branch = (kind, ceiling) => ({ type: "object", required: ["kind"], properties: {
      kind: { type: "string", const: kind }, value: { type: "number", "x-weaver": { maxOverrideLayer: ceiling } },
    } });
    input.schemas[0].schema = { type: "object", properties: { kind: { type: "string" }, value: { type: "number" } }, [keyword]: [branch("open", "upper"), branch("locked", "incident")] };
    const s = await sessionHost({ provider, input });
    try {
      assert.equal(s.reader.get(["value"]), undefined);
      const result = await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/kind", layer: "upper", value: "open" }));
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.error.code, "POLICY_VIOLATION");
      const replacement = await s.mutations.apply(commands(input, { operation: "set", path: "/alpha", layer: "upper", value: { kind: "open", value: 9 } }));
      assert.equal(replacement.success, false, JSON.stringify(replacement));
      assert.equal(replacement.error.code, "POLICY_VIOLATION");
      assert.equal(provider.writes, 0); assert.equal(s.reader.get(["value"]), undefined);
    } finally { await s.root.dispose(); }
  }
});

test("absent tuple-index metadata blocks an above-ceiling whole-array assignment before effects", async () => {
  const low = new WritableMemory("low", "base", { alpha: { list: [] } });
  const high = new WritableMemory("high", "upper", { alpha: {} });
  const input = writableOptions([low, high]);
  input.schemas[0].schema.properties.list.items = [{ type: "number" }, { type: "number" },
    { type: "number", "x-weaver": { maxOverrideLayer: "base" } }];
  const s = await writable({ provider: low, input, host: { writers: [writer(low), writer(high)] } });
  try {
    const result = await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/list", layer: "upper", value: [1] }));
    assert.equal(result.error.code, "POLICY_VIOLATION");
    assert.equal(high.writes, 0); assert.deepEqual(s.reader.get(["list"]), []);
  } finally { await s.root.dispose(); }
});

for (const [label, initial] of [["object", {}], ["null", null], ["missing", undefined], ["array control", []]]) {
  test(`declared mixed-type tuple ceiling rejects destructive upper writes from ${label} without effects`, async () => {
    const low = new WritableMemory("low", "base", { alpha: initial === undefined ? {} : { list: initial } });
    const high = new WritableMemory("high", "upper", { alpha: {} });
    const input = writableOptions([low, high]);
    input.schemas[0].schema.properties.list = { type: ["object", "array", "null"], additionalProperties: true,
      items: [{ type: "number", "x-weaver": { maxOverrideLayer: "base" } }] };
    const s = await writable({ provider: low, input, host: { writers: [writer(low), writer(high)] } });
    try {
      const revision = s.reader.revision;
      assert.deepEqual(s.reader.get(["list"]), initial);
      for (const command of [
        ...[null, {}, []].map((value) => ({ operation: "set", value })), { operation: "remove" },
      ]) {
        const result = await s.mutations.apply(commands(input, { ...command, path: "/alpha/list", layer: "upper" }));
        assert.equal(result.success, false, JSON.stringify(result));
        assert.equal(result.error.code, "POLICY_VIOLATION");
        assert.deepEqual([low.writes, low.removes, low.flushes, high.writes, high.removes, high.flushes], [0, 0, 0, 0, 0, 0]);
        assert.equal(s.reader.revision, revision); assert.deepEqual(s.reader.get(["list"]), initial);
      }
      high.entries.alpha.list = null;
      assert.equal((await s.root.reloadProvider(high.id)).ok, true);
      assert.deepEqual(s.reader.get(["list"]), initial);
      assert.equal(s.reader.get(["list"], { layer: "upper" }), null);
      const value = initial === null ? {} : null;
      const allowed = await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/list", layer: "base", value }));
      assert.equal(allowed.success, true, JSON.stringify(allowed));
      assert.deepEqual(s.reader.get(["list"]), value); assert.equal(low.writes, 1);
    } finally { await s.root.dispose(); }
  });
}

test("tuple ceiling protection does not widen ambiguous numeric read membership", async () => {
  for (const initial of [{ "0": 1 }, [1]]) {
    const low = new WritableMemory("low", "base", { alpha: { list: initial } });
    const high = new WritableMemory("high", "upper", { alpha: {} });
    const input = writableOptions([low, high]);
    input.schemas[0].schema.properties.list = { type: ["object", "array", "null"], additionalProperties: true,
      properties: { "0": { type: "number" } }, items: [{ type: "number", "x-weaver": { maxOverrideLayer: "base" } }] };
    const s = await writable({ provider: low, input, host: { writers: [writer(low), writer(high)] } });
    const assertProjection = () => {
      if (Array.isArray(initial)) assert.throws(() => s.reader.get(["list"]), { code: "FORBIDDEN" });
      else assert.deepEqual(s.reader.get(["list"]), {});
    };
    try {
      assertProjection();
      const revision = s.reader.revision;
      const result = await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/list", layer: "upper", value: null }));
      assert.equal(result.error.code, "POLICY_VIOLATION", JSON.stringify(result));
      assert.equal(s.reader.revision, revision); assertProjection();
      assert.deepEqual(low.entries.alpha.list, initial);
      assert.deepEqual([low.writes, low.removes, low.flushes, high.writes, high.removes, high.flushes], [0, 0, 0, 0, 0, 0]);
    } finally { await s.root.dispose(); }
  }
});

test("array index ceilings reject whole-array replacement, remove and patch without partial splicing", async () => {
  const low = new WritableMemory("low", "base", { alpha: { list: [1, 2] } });
  const high = new WritableMemory("high", "upper", { alpha: { list: [9] } });
  const input = writableOptions([low, high]);
  input.schemas[0].schema.properties.list.items = { type: "number", "x-weaver": { maxOverrideLayer: "base" } };
  const s = await writable({ provider: low, input, host: { writers: [writer(low), writer(high)] } });
  try {
    assert.deepEqual(s.reader.get(["list"]), [1, 2]);
    for (const command of [
      { operation: "set", path: "/alpha/list", value: [] },
      { operation: "remove", path: "/alpha/list" },
      { operation: "patch", path: "/alpha/list/0", value: 3 },
    ]) {
      const result = await s.mutations.apply(commands(input, { ...command, layer: "upper" }));
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.error.code, "POLICY_VIOLATION");
    }
    assert.deepEqual([high.writes, high.removes, high.flushes], [0, 0, 0]);
    assert.deepEqual(s.reader.get(["list"]), [1, 2]);
  } finally { await s.root.dispose(); }
});

test("unknown-effect readback uses registered ceilings without falsifying the outcome or clearing its fence", async () => {
  const low = new WritableMemory(), high = new WritableMemory("high", "upper", { alpha: { flag: "raw upper", cfg: { a: 8 } } });
  const input = writableOptions([low, high]);
  input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  const original = high.write;
  high.write = async function (key, value) { await original.call(this, key, value); throw Error("PRIVATE provider failure"); };
  const s = await writable({ provider: low, input, host: { writers: [writer(low), writer(high)] } });
  try {
    const revision = s.reader.revision, loads = high.loads;
    const result = await s.mutations.apply(commands(input, { operation: "set", layer: "upper", path: "/alpha/cfg/a", value: 9 }));
    assert.equal(result.outcome, "unknown"); assert.equal(result.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.equal(high.loads, loads + 1); assert.equal(high.writes, 1);
    assert.notEqual(s.reader.revision, revision);
    assert.equal(s.reader.get(["cfg", "a"]), 9);
    assert.equal(s.reader.get(["flag"]), "before");
    assert.equal(s.reader.get(["flag"], { layer: "upper" }), "raw upper");
    assert.equal(s.reader.inspect(["flag"]).effectiveLayer, "base");
    assert.equal(s.root.mode, "degraded");
    const fenced = await s.mutations.apply(commands(input, { operation: "set", layer: "upper", path: "/alpha/cfg/a", value: 10 }));
    assert.equal(fenced.error.code, "WRITE_UNAVAILABLE"); assert.equal(high.writes, 1);
  } finally { await s.root.dispose(); }
});
