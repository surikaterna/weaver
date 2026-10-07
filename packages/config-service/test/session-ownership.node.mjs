import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionHost } from "./fixtures/session-host.mjs";
import { principal } from "./fixtures/authority.mjs";
import { WritableMemory, writableOptions, commands } from "./fixtures/writable-memory.mjs";

test("explicit management permission needs its own complete grant and ordinary same-name token owns nothing", async () => {
  const s = await sessionHost();
  try {
    const info = (await s.activate()).value;
    const adminClaims = { ...s.claims, principalId: "administrator", sessionPermissions: ["read", "extend", "deactivate", "manage"] };
    const denied = s.controller.forSessions(s.controller.mint({ ...adminClaims, grants: [] }));
    assert.equal(denied.get(info.id), null); assert.deepEqual(denied.list(), []);
    assert.equal((await denied.deactivate({ sessionId: info.id })).error.code, "FORBIDDEN");
    const admin = s.controller.forSessions(s.controller.mint(adminClaims));
    assert.equal(admin.get(info.id).activatedBy, s.claims.principalId);
    assert.equal((await admin.extend({ sessionId: info.id, durationMs: 150 })).ok, true);
    assert.equal((await admin.deactivate({ sessionId: info.id })).ok, true);
    assert.equal(s.sessions.get(info.id), null);
  } finally { await s.root.dispose(); }
});

test("schema uncertainty discards session timers/metadata without exposing fallback or clearing fence", async () => {
  class SchemaMemory extends WritableMemory {
    fail = false;
    async write(key, value) { const result = await super.write(key, value); if (this.fail) throw Error("uncertain"); return result; }
  }
  const provider = new SchemaMemory();
  const s = await sessionHost({ provider, host: { registry: { storage: { kind: "provider", providerId: provider.id } } } });
  try {
    const info = (await s.activate()).value;
    assert.equal((await s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: info.id, value: "temporary" }))).success, true);
    const schemas = s.controller.forSchemas(s.controller.mint({ ...s.claims, schemaPermissions: ["read", "register"] }));
    const request = structuredClone(s.input.schemas[0]); request.schema.description = "new metadata";
    provider.fail = true;
    assert.equal((await schemas.register(request)).outcome, "unknown");
    assert.equal(s.clock.callbacks.size, 0); assert.deepEqual(s.sessions.list(), []);
    assert.throws(() => s.reader.get(["flag"]), { code: "SERVER_DEGRADED" });
    assert.equal((await s.activate()).error.code, "WRITE_UNAVAILABLE");
    assert.equal(s.root.mode, "degraded");
  } finally { await s.root.dispose(); }
});

test("invalid session configuration rejects before provider IO and timers", async () => {
  for (const host of [
    { sessions: undefined },
    { sessions: { defaultDurationMs: 100, maxDurationMs: 10, maxActiveSessions: 1 } },
    { sessions: { defaultDurationMs: 100, maxDurationMs: 100, maxActiveSessions: 0 } },
  ]) {
    const provider = new WritableMemory();
    await assert.rejects(sessionHost({ provider, host }), { code: "VALIDATION_ERROR" });
    assert.equal(provider.loads, 0);
  }
  const provider = new WritableMemory(), input = writableOptions([provider]);
  input.layers.push({ kind: "session", layer: "incident" }, { kind: "session", layer: "another" });
  await assert.rejects(sessionHost({ provider, input }), { code: "VALIDATION_ERROR" });
  assert.equal(provider.loads, 0);
});

test("async session-read decisions fail closed and rejected promises are contained", async () => {
  const s = await sessionHost({ host: { hostAuthority: {
    authorizeReadSync(_principal, request) { return request.operation === "session-read" ? Promise.reject(Error("invalid synchronous hook")) : "allowed"; },
    async authorizeWrite() { return "allowed"; },
  } } });
  try {
    const info = (await s.activate()).value;
    assert.equal(s.sessions.get(info.id), null); assert.deepEqual(s.sessions.list(), []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.reader.get(["flag"]), "before");
  } finally { await s.root.dispose(); }
});

test("a later metadata callback cannot return earlier entries after revoking their creator or caller", async () => {
  let revoke, reads = 0;
  const s = await sessionHost({ host: { hostAuthority: {
    authorizeReadSync(_principal, request) {
      if (request.operation === "session-read" && ++reads === 2) revoke();
      return "allowed";
    },
    async authorizeWrite() { return "allowed"; },
  } } });
  try {
    await s.activate(); await s.activate();
    const admin = s.controller.forSessions(s.controller.mint({ ...s.claims, sessionPermissions: ["read", "manage"] }));
    revoke = () => s.controller.revoke(s.token);
    assert.deepEqual(admin.list(), []);
    await s.root.flush();
    const owner = s.controller.mint(s.claims), own = s.controller.forSessions(owner);
    const request = { identity: s.input.identity, namespace: "/alpha", reason: "test", emergency: false };
    await own.activate(request); await own.activate(request);
    reads = 0; revoke = () => s.controller.revoke(owner);
    assert.throws(() => own.list(), { code: "FORBIDDEN" });
  } finally { await s.root.dispose(); }
});

test("post-await creator revocation denies activation before any controller/timer or generation publication", async () => {
  let controller, token;
  const s = await sessionHost({ host: { hostAuthority: {
    authorizeReadSync() { return "allowed"; },
    async authorizeWrite(_principal, request) {
      if (request.operation === "session-activate") { await Promise.resolve(); controller.revoke(token); }
      return "allowed";
    },
  } } });
  controller = s.controller; token = s.token;
  const revision = s.root.restartState.revision;
  try {
    assert.equal((await s.activate()).error.code, "FORBIDDEN");
    assert.equal(s.clock.callbacks.size, 0); assert.equal(s.clock.count, 0);
    assert.equal(s.root.restartState.revision, revision); assert.equal(s.provider.writes, 0);
  } finally { await s.root.dispose(); }
});

test("unknown mixed effects read back complete observations, preserve sticky fence and permit removal", async () => {
  class UnknownMemory extends WritableMemory {
    async write(key, value) { await super.write(key, value); throw Error("uncertain private detail"); }
  }
  const s = await sessionHost({ provider: new UnknownMemory() });
  try {
    const info = (await s.activate()).value;
    const result = await s.mutations.apply(commands(s.input,
      { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: info.id, value: "ephemeral observed" },
      { operation: "set", path: "/alpha/flag", value: "persistent observed" },
    ));
    assert.equal(result.outcome, "unknown"); assert.equal(s.provider.loads, 2);
    assert.equal(s.reader.get(["flag"]), "ephemeral observed"); assert.equal(s.root.mode, "degraded");
    const count = s.clock.count;
    assert.equal((await s.activate()).error.code, "WRITE_UNAVAILABLE");
    assert.equal((await s.sessions.extend({ sessionId: info.id })).error.code, "WRITE_UNAVAILABLE");
    assert.equal(s.clock.count, count);
    assert.equal((await s.sessions.deactivate({ sessionId: info.id })).ok, true);
    assert.equal(s.reader.get(["flag"]), "persistent observed"); assert.equal(s.root.mode, "degraded");
    assert.equal((await s.mutations.apply(commands(s.input, { operation: "remove", path: "/alpha/flag" }))).error.code, "WRITE_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /private detail/);
  } finally { await s.root.dispose(); }
});

test("root disposal cancels all owned session timers, rejects handles and preserves borrowed provider", async () => {
  class Borrowed extends WritableMemory { disposed = 0; dispose() { this.disposed++; } }
  const s = await sessionHost({ provider: new Borrowed() });
  const a = (await s.activate()).value, b = (await s.activate()).value;
  const callbacks = [...s.clock.callbacks.values()];
  assert.equal(s.clock.callbacks.size, 2);
  assert.equal((await s.root.dispose()).ok, true);
  assert.equal((await s.root.dispose()).ok, true);
  assert.equal(s.clock.callbacks.size, 0); assert.equal(s.provider.disposed, 0);
  for (const { fn } of callbacks) fn();
  assert.throws(() => s.sessions.get(a.id), { code: "DISPOSED" });
  assert.equal((await s.sessions.extend({ sessionId: b.id })).error.code, "DISPOSED");
});

test("missing emergency/layer/view/namespace grants deny before timers and metadata getters do not execute", async () => {
  const s = await sessionHost();
  try {
    const ordinary = s.controller.forSessions(s.controller.mint({ ...s.claims, sessionPermissions: ["activate"] }));
    const request = { identity: s.input.identity, namespace: "/alpha", reason: "test", emergency: true };
    assert.equal((await ordinary.activate(request)).error.code, "FORBIDDEN");
    const noLayer = principal(s.input, { sessionPermissions: ["activate"] }); noLayer.grants[0].layers = ["base"];
    assert.equal((await s.controller.forSessions(s.controller.mint(noLayer)).activate({ ...request, emergency: false })).error.code, "FORBIDDEN");
    assert.equal((await s.activate({ namespace: "/beta" })).error.code, "FORBIDDEN");
    assert.equal((await s.activate({ viewId: "foreign" })).error.code, "FORBIDDEN");
    assert.equal((await s.activate({ namespace: "/" })).error.code, "VALIDATION_ERROR");
    let getters = 0;
    assert.equal((await s.sessions.activate({ ...request, get reason() { getters++; return "spoof"; } })).error.code, "VALIDATION_ERROR");
    assert.equal(getters, 0); assert.equal(s.clock.count, 0);
  } finally { await s.root.dispose(); }
});
