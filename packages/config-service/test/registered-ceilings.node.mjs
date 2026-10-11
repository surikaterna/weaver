import assert from "node:assert/strict";
import { test } from "node:test";
import { writable, WritableMemory, writableOptions, writer, commands, writeBinding } from "./fixtures/writable-memory.mjs";
import { sessionHost } from "./fixtures/session-host.mjs";
import { principal } from "./fixtures/authority.mjs";

test("registered custom ceilings govern hydration, raw inspection, reload and recreation", async () => {
  const base = new WritableMemory("low", "custom:base");
  const top = new WritableMemory("high", "custom:top", { alpha: { flag: "masked", cfg: { a: 9 } } });
  const input = writableOptions([base, top]);
  input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "custom:base" };
  const make = () => writable({ provider: base, input, host: { writers: [writer(base), writer(top)] } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await make();
    try {
      assert.equal(s.reader.get(["flag"]), "before");
      assert.equal(s.reader.get(["flag"], { layer: "custom:top" }), "masked");
      assert.equal(s.reader.snapshot().value.value.flag, "before");
      const inspection = s.reader.inspect(["flag"]);
      assert.equal(inspection.effectiveLayer, "custom:base");
      top.entries.alpha.flag = "external";
      assert.equal((await s.root.reloadProvider(top.id)).ok, true);
      assert.equal(s.reader.get(["flag"]), "before");
      assert.equal(s.reader.get(["flag"], { layer: "custom:top" }), "external");
      top.entries.alpha.flag = "masked";
    } finally { await s.root.dispose(); }
  }
});

test("cold scope prefixes share their declared slot rank, including an empty session ceiling slot", async () => {
  const base = new WritableMemory(), top = new WritableMemory("top", "upper", { alpha: { flag: "top", cfg: { a: 90 } } });
  const first = new WritableMemory("first", "scope", { alpha: { flag: "parent", cfg: { a: 20 } } });
  const second = new WritableMemory("second", "scope", { alpha: { flag: "child", cfg: { a: 30 } } });
  const parent = [{ scopeId: "tenant", value: "a" }], child = [...parent, { scopeId: "region", value: "b" }];
  const input = writableOptions([base, top]);
  input.layers.splice(1, 0, { kind: "session", layer: "incident" }, { kind: "scope", layer: "scope", providerIds: [first.id, second.id] });
  input.providers.push(writeBinding(first, { scopePath: parent }), writeBinding(second, { scopePath: child }));
  input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "scope" };
  input.schemas[0].schema.properties.cfg.properties.a["x-weaver"] = { maxOverrideLayer: "incident" };
  const claims = principal(input, { sessionPermissions: ["read"] });
  claims.grants.push(...[parent, child].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  const s = await sessionHost({ provider: base, input, claims, host: { writers: [writer(base), writer(top), writer(first), writer(second)] } });
  try {
    assert.equal(first.loads + second.loads, 0);
    assert.equal(s.reader.get(["flag"]), "before");
    const a = s.reader.withScope(parent), ab = s.reader.withScope(child);
    await a.prepare(); await ab.prepare();
    assert.equal(a.get(["flag"]), "parent"); assert.equal(ab.get(["flag"]), "child");
    assert.equal(ab.get(["cfg", "a"]), 1, "empty incident slot still supplies a known ceiling rank");
    assert.equal(ab.inspect(["flag"]).effectiveLayer, "scope");
    assert.equal(ab.get(["flag"], { layer: "upper" }), "top");
    const denied = await s.mutations.apply(commands(input, { identity: { environment: "east", scopePath: child }, operation: "set", path: "/alpha/flag", layer: "upper", value: "blocked" }));
    assert.equal(denied.error.code, "FORBIDDEN"); assert.equal(top.writes, 0);
    const aboveCeiling = await s.mutations.apply(commands(input, { identity: { environment: "east", scopePath: child }, operation: "set", path: "/alpha/cfg/a", layer: "scope", value: 99 }));
    assert.equal(aboveCeiling.error.code, "POLICY_VIOLATION");
    assert.deepEqual([first.writes, second.writes, first.flushes, second.flushes], [0, 0, 0, 0]);
    const allowed = await s.mutations.apply(commands(input, { identity: { environment: "east", scopePath: child }, operation: "set", path: "/alpha/flag", layer: "scope", value: "allowed" }));
    assert.equal(allowed.success, true, JSON.stringify(allowed));
    assert.equal(ab.get(["flag"]), "allowed"); assert.equal(a.get(["flag"]), "parent");
  } finally { await s.root.dispose(); }
});

test("provider labels and loaded emergency/source-policy fields cannot grant exemptions", async () => {
  const low = new WritableMemory();
  const high = new WritableMemory("pretender", "emergency", { alpha: { flag: "pretender" } });
  high.load = async () => ({ entries: high.entries, trustedEmergency: true, sourceCeilings: [], emergency: true });
  const input = writableOptions([low, high]);
  input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  await assert.rejects(writable({ provider: low, input }), { code: "SERVER_DEGRADED" });
  high.load = async () => ({ entries: high.entries });
  const s = await writable({ provider: low, input });
  try {
    assert.equal(s.reader.get(["flag"]), "before");
    assert.equal(s.reader.get(["flag"], { layer: "emergency" }), "pretender");
    assert.equal(s.reader.inspect(["flag"]).effectiveLayer, "base");
  } finally { await s.root.dispose(); }
});

test("unknown ceiling anywhere in bootstrap declarations fails before provider IO", async () => {
  for (const environment of ["east", "inactive"]) {
    const provider = new WritableMemory();
    const input = writableOptions([provider]);
    input.schemas.push({ ...structuredClone(input.schemas[0]), environment,
      schema: { type: "object", anyOf: [{ type: "object" }, { type: "object", properties: { x: { type: "number", "x-weaver": { maxOverrideLayer: "not-configured" } } } }] } });
    await assert.rejects(writable({ provider, input }), { code: "VALIDATION_ERROR" });
    assert.deepEqual([provider.loads, provider.writes, provider.flushes], [0, 0, 0]);
  }
});

test("masked/equal writes above ceilings reject before effects, allowed siblings still write", async () => {
  const base = new WritableMemory();
  const top = new WritableMemory("high", "upper", { alpha: { flag: "before", cfg: { a: 1 } } });
  const input = writableOptions([base, top]);
  input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  input.schemas[0].schema.properties.cfg.properties.a["x-weaver"] = { maxOverrideLayer: "base" };
  input.schemas[0].schema.properties.cfg.properties.open = { type: "number" };
  const s = await writable({ provider: base, input, host: { writers: [writer(base), writer(top)] } });
  try {
    const revision = s.reader.revision;
    for (const command of [
      { operation: "set", path: "/alpha/flag", value: "before" },
      { operation: "remove", path: "/alpha/flag" },
      { operation: "set", path: "/alpha/cfg", value: {} },
      { operation: "patch", path: "/alpha/cfg/a", value: 9 },
    ]) {
      const result = await s.mutations.apply(commands(input, { ...command, layer: "upper" }));
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.error.code, "POLICY_VIOLATION");
    }
    assert.equal(s.reader.revision, revision);
    assert.deepEqual([top.writes, top.removes, top.flushes], [0, 0, 0]);
    const result = await s.mutations.apply(commands(input, { operation: "patch", path: "/alpha/cfg/open", layer: "upper", value: 7 }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(s.reader.get(["cfg", "a"]), 1);
    assert.equal(s.reader.get(["cfg", "open"]), 7);
  } finally { await s.root.dispose(); }
});

for (const placement of ["root", "nested", "allOf", "anyOf", "oneOf"]) test(`native ${placement} not and positive ceilings govern real allowed-rank writes independently`, async () => {
    const low = new WritableMemory(), high = new WritableMemory("high", "upper", { alpha: { flag: "upper" } });
    const input = writableOptions([low, high]); input.schemas = [input.schemas[0]];
    const negative = { type: "object", required: ["bad"], additionalProperties: true };
    input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
    let path = "/alpha/bad";
    if (placement === "nested") {
      input.schemas[0].schema.properties.cfg.properties.bad = { type: "boolean" };
      input.schemas[0].schema.properties.cfg.not = negative;
      path = "/alpha/cfg/bad";
    } else {
      input.schemas[0].schema.properties.bad = { type: "boolean" };
      if (placement === "root") input.schemas[0].schema.not = negative;
      else {
        input.schemas[0].schema[placement] = [{ type: "object", additionalProperties: true, not: negative }];
        if (placement !== "allOf") input.schemas[0].schema[placement].push({ type: "object", additionalProperties: true, required: ["flag"], properties: { flag: { type: "string", const: "alternative" } } });
      }
    }
    const s = await writable({ provider: low, input, host: { writers: [writer(low), writer(high)] } });
    try {
      assert.equal(s.reader.get(["flag"]), "before");
      const revision = s.reader.revision;
      const invalid = await s.mutations.apply(commands(input, { operation: "set", layer: "base", path, value: true }));
      assert.equal(invalid.error.code, "VALIDATION_ERROR", JSON.stringify(invalid));
      assert.equal(s.reader.revision, revision);
      assert.deepEqual([low.writes, low.removes, low.flushes, high.writes, high.removes, high.flushes], [0, 0, 0, 0, 0, 0]);
      const valid = await s.mutations.apply(commands(input, { operation: "set", layer: "base", path: "/alpha/flag", value: "valid" }));
      assert.equal(valid.success, true, JSON.stringify(valid)); assert.equal(s.reader.get(["flag"]), "valid");
      const above = await s.mutations.apply(commands(input, { operation: "set", layer: "upper", path: "/alpha/flag", value: "blocked" }));
      assert.equal(above.error.code, "POLICY_VIOLATION", JSON.stringify(above));
      assert.deepEqual([high.writes, high.removes, high.flushes], [0, 0, 0]);
    } finally { await s.root.dispose(); }
});

test("unknown names solely under not or inactive negative alternatives fail before any bootstrap IO", async () => {
  for (const environment of ["east", "inactive"]) for (const keyword of ["not", "double-not", "anyOf", "oneOf"]) {
    const low = new WritableMemory(), input = writableOptions([low]);
    const forbidden = { type: "object", "x-weaver": { maxOverrideLayer: "unknown" }, required: ["bad"] };
    const negative = { type: "object", not: forbidden };
    const schema = keyword === "not" ? negative : keyword === "double-not" ? { type: "object", not: negative } : { type: "object", [keyword]: [{ type: "object" }, negative] };
    input.schemas.push({ ...structuredClone(input.schemas[0]), environment, schema });
    await assert.rejects(writable({ provider: low, input }), { code: "VALIDATION_ERROR" });
    assert.deepEqual([low.loads, low.writes, low.removes, low.flushes], [0, 0, 0, 0]);
  }
});
