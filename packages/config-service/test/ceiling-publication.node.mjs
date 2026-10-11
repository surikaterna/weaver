import assert from "node:assert/strict";
import { test } from "node:test";
import { writable, WritableMemory, writableOptions, writer } from "./fixtures/writable-memory.mjs";
import { principal } from "./fixtures/authority.mjs";
import { sessionHost } from "./fixtures/session-host.mjs";
import { commands } from "./fixtures/writable-memory.mjs";

test("candidate registry tightening/relaxation restages existing raw data and unknown names publish nothing", async () => {
  const low = new WritableMemory();
  const high = new WritableMemory("high", "upper", { alpha: { flag: "high" } });
  const input = writableOptions([low, high]);
  input.schemas = [input.schemas[0]];
  const claims = principal(input, { schemaPermissions: ["register", "read"] });
  const s = await writable({ provider: low, input, claims, host: { writers: [writer(low), writer(high)] } });
  try {
    const admin = s.controller.forSchemas(s.token);
    assert.equal(s.reader.get(["flag"]), "high");
    for (const maxOverrideLayer of ["base", "upper", undefined, "base"]) {
      const request = structuredClone(input.schemas[0]);
      request.schema.properties.flag["x-weaver"] = { ...(maxOverrideLayer ? { maxOverrideLayer } : {}), reloadBehavior: "restart-required" };
      const previousValue = s.reader.get(["flag"]);
      const result = await admin.register(request);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(s.reader.get(["flag"]), maxOverrideLayer === "base" ? "before" : "high");
      assert.equal(s.reader.get(["flag"], { layer: "upper" }), "high");
      assert.equal(s.root.restartState.pending, previousValue === s.reader.get(["flag"]) ? "none" : "restart-required");
      await s.root.acknowledgeRestart(s.root.restartState.revision);
    }
    const revision = s.reader.revision, schemaRevision = admin.revision;
    const invalid = structuredClone(input.schemas[0]);
    invalid.schema.properties.flag["x-weaver"] = { maxOverrideLayer: "unknown" };
    const result = await admin.register(invalid);
    assert.equal(result.success, false); assert.equal(result.error.code, "VALIDATION_ERROR");
    assert.equal(s.reader.revision, revision); assert.equal(admin.revision, schemaRevision);
    assert.deepEqual([low.writes, high.writes, low.flushes, high.flushes], [0, 0, 0, 0]);
  } finally { await s.root.dispose(); }
});

test("durable candidate ceiling waits for flush, then expired emergency cannot enter its published generation", async () => {
  const low = new WritableMemory(), high = new WritableMemory("high", "upper", { alpha: { flag: "upper" } });
  const input = writableOptions([low, high]); input.schemas = [input.schemas[0]];
  let blocked = false, release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  low.flush = async () => { low.flushes++; if (blocked) { entered(); await new Promise((resolve) => { release = resolve; }); } };
  const s = await sessionHost({ provider: low, input, host: {
    registry: { storage: { kind: "provider", providerId: low.id } }, writers: [writer(low, { flush: "required" }), writer(high)],
  } });
  try {
    const admin = s.controller.forSchemas(s.controller.mint({ ...s.claims, schemaPermissions: ["read", "register"] }));
    const info = (await s.activate({ emergency: true })).value;
    assert.equal((await s.mutations.apply(commands(input, { layer: "incident", sessionId: info.id, operation: "set", path: "/alpha/flag", value: "emergency" }))).success, true);
    const oldRevision = s.reader.revision, schemaRevision = admin.revision;
    const events = [];
    const delivered = new Promise((resolve) => s.reader.onChange(["flag"], (event) => { events.push(event); resolve(event); }));
    const request = structuredClone(input.schemas[0]);
    request.schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base", reloadBehavior: "restart-required" };
    blocked = true; const pending = admin.register(request); await waiting;
    assert.equal(s.reader.get(["flag"]), "emergency"); assert.equal(s.reader.revision, oldRevision); assert.equal(admin.revision, schemaRevision);
    s.clock.time += 101; release(); blocked = false;
    const result = await pending; assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(s.reader.get(["flag"]), "before"); assert.equal(s.reader.get(["flag"], { layer: "upper" }), "upper");
    assert.equal(s.root.restartState.pending, "restart-required");
    assert.equal(low.entries.alpha.flag, "before"); assert.equal(high.entries.alpha.flag, "upper");
    const event = await delivered;
    assert.equal(event.kind, "invalidation"); assert.equal(event.cause, "schema");
    assert.equal(event.previousRevision, oldRevision); assert.equal(event.revision, s.reader.revision);
    assert.equal(Object.hasOwn(event, "current"), false);
    assert.equal(events.length, 1);
    const count = events.length;
    s.clock.fire(); await s.root.flush();
    assert.equal(events.length, count, "removal cannot repeat the already-published effective fallback");
    const initial = structuredClone(low.entries._weaver.registry.schemas);
    const restored = await writable({ provider: low, input: { ...input, schemas: [], layers: input.layers.filter((slot) => slot.kind !== "session") },
      host: { registry: { initial }, writers: [writer(low), writer(high)] } });
    try { assert.equal(restored.reader.get(["flag"]), "before"); }
    finally { await restored.root.dispose(); }
  } finally { blocked = false; release?.(); await s.root.dispose(); }
});

test("candidate negative-only names validate before persistence and known annotations do not create ceilings", async () => {
  const low = new WritableMemory(), high = new WritableMemory("high", "upper", { alpha: { flag: "upper" } });
  const input = writableOptions([low, high]); input.schemas = [input.schemas[0]];
  const claims = principal(input, { schemaPermissions: ["register", "read"] });
  const s = await writable({ provider: low, input, claims, host: {
    registry: { storage: { kind: "provider", providerId: low.id } }, writers: [writer(low, { flush: "required" }), writer(high)],
  } });
  try {
    const admin = s.controller.forSchemas(s.token);
    for (const placement of ["not", "double-not", "inactive"]) {
      const request = structuredClone(input.schemas[0]);
      const forbidden = { type: "object", "x-weaver": { maxOverrideLayer: "unknown" } };
      if (placement === "not") request.schema.not = forbidden;
      else if (placement === "double-not") request.schema.not = { type: "object", not: forbidden };
      else request.schema.anyOf = [{ type: "object", additionalProperties: true }, { type: "object", not: forbidden }];
      const revision = admin.revision, dataRevision = s.reader.revision;
      const counts = [low.writes, low.removes, low.flushes, high.writes, high.removes, high.flushes];
      const result = await admin.register(request);
      assert.equal(result.error.code, "VALIDATION_ERROR", JSON.stringify(result));
      assert.equal(admin.revision, revision); assert.equal(s.reader.revision, dataRevision);
      assert.deepEqual([low.writes, low.removes, low.flushes, high.writes, high.removes, high.flushes], counts);
    }
    const request = structuredClone(input.schemas[0]);
    request.schema.not = { type: "object", additionalProperties: true, enum: [{ flag: "forbidden" }], "x-weaver": { maxOverrideLayer: "base" } };
    assert.equal((await admin.register(request)).success, true);
    assert.equal(s.reader.get(["flag"]), "upper");
    const result = await s.mutations.apply(commands(input, { operation: "set", layer: "upper", path: "/alpha/flag", value: "legal" }));
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(s.reader.get(["flag"]), "legal");
  } finally { await s.root.dispose(); }
});
