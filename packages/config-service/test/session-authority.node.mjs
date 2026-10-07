import assert from "node:assert/strict";
import { test } from "node:test";
import { commands } from "./fixtures/writable-memory.mjs";
import { principal } from "./fixtures/authority.mjs";
import { sessionHost as setup } from "./fixtures/session-host.mjs";

test("canonical session port writes only through apply, publishes fallback and returns metadata only", async () => {
  const s = await setup();
  try {
    const events = []; s.reader.onChange(["flag"], (event) => events.push(event));
    const created = await s.activate();
    assert.equal(created.ok, true, JSON.stringify(created));
    const info = created.value;
    assert.equal(info.activatedBy, "host-verified");
    assert.equal(info.followUpDeadline, info.activatedAt + 86400000);
    assert.deepEqual(Object.keys(s.sessions).sort(), ["activate", "deactivate", "extend", "get", "list"]);
    assert.equal("overrides" in info, false); assert.equal("provider" in info, false);
    assert.deepEqual(s.sessions.get(info.id), info); assert.equal(s.sessions.list().length, 1);
    assert.equal(events.length, 0);
    const result = await s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: info.id, value: "temporary" }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(s.reader.get(["flag"]), "temporary"); assert.equal(s.provider.writes, 0);
    assert.equal((await s.sessions.extend({ sessionId: info.id, durationMs: 200 })).ok, true);
    assert.equal(events.length, 1);
    assert.equal((await s.sessions.deactivate({ sessionId: info.id })).ok, true);
    assert.equal(s.reader.get(["flag"]), "before");
    assert.equal(s.sessions.get(info.id), null); assert.deepEqual(s.sessions.list(), []);
    assert.equal(events.length, 2); assert.equal(events[1].cause, "session");
  } finally { await s.root.dispose(); }
});

test("multiple sessions keep activation ordering across extension and deadline cleanup", async () => {
  const s = await setup();
  try {
    const a = (await s.activate()).value, b = (await s.activate()).value;
    for (const [sessionId, value] of [[a.id, "first"], [b.id, "second"]]) {
      const result = await s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId, value }));
      assert.equal(result.success, true, JSON.stringify(result));
    }
    await s.sessions.extend({ sessionId: a.id, durationMs: 200 });
    assert.equal(s.reader.get(["flag"]), "second");
    s.clock.time += 100; s.clock.fire();
    assert.equal(s.sessions.get(b.id), null);
    assert.deepEqual(s.sessions.list().map((info) => info.id), [a.id]);
    assert.equal((await s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: b.id, value: "expired" }))).success, false);
    await s.root.flush();
    assert.equal(s.reader.get(["flag"]), "first");
    assert.equal(s.clock.callbacks.size, 1);
  } finally { await s.root.dispose(); }
});

test("extension without duration retains the session's current duration rather than resetting to host default", async () => {
  const s = await setup();
  try {
    const info = (await s.activate({ durationMs: 50 })).value;
    s.clock.time += 10;
    const extended = await s.sessions.extend({ sessionId: info.id });
    assert.equal(extended.ok, true); assert.equal(extended.value.expiresAt, s.clock.time + 50);
  } finally { await s.root.dispose(); }
});

test("foreign/replaced capabilities and wrong selectors never acquire session authority", async () => {
  const s = await setup(), other = await setup();
  try {
    assert.throws(() => other.controller.forSessions(s.token), { code: "FORBIDDEN" });
    assert.throws(() => s.controller.forSessions({ ...s.token }), { code: "FORBIDDEN" });
    const a = (await s.activate()).value;
    const sameName = s.controller.mint(s.claims);
    assert.equal(s.controller.forSessions(sameName).get(a.id), null);
    assert.deepEqual(s.controller.forSessions(sameName).list(), []);
    for (const [mutation, command] of [
      [s.controller.forMutations(sameName), { layer: "incident", sessionId: a.id }],
      [other.mutations, { layer: "incident", sessionId: a.id }],
      [s.mutations, { layer: "base", sessionId: a.id }],
      [s.mutations, { layer: "incident" }],
    ]) assert.equal((await mutation.apply(commands(s.input, { operation: "set", path: "/alpha/flag", value: "denied", ...command }))).success, false);
    const replacement = s.controller.replace(s.token, s.claims);
    assert.equal(s.controller.forSessions(replacement).get(a.id), null);
    await s.root.flush();
    assert.equal(s.clock.callbacks.size, 0);
    assert.equal(s.provider.writes, 0);
  } finally { await s.root.dispose(); await other.root.dispose(); }
});

test("session and schema permissions are independent and input actors/modes cannot grant authority", async () => {
  const s = await setup();
  try {
    assert.throws(() => s.controller.forSchemas(s.token).snapshot(), { code: "FORBIDDEN" });
    const missing = s.controller.forSessions(s.controller.mint(principal(s.input, { schemaPermissions: ["register", "read"] })));
    const request = { identity: s.input.identity, namespace: "/alpha", reason: "test", emergency: false };
    assert.equal((await missing.activate(request)).error.code, "FORBIDDEN");
    for (const extra of [{ activatedBy: "admin" }, { mode: "god-mode" }, { elevatedAuth: { token: "fake" } }])
      assert.equal((await s.sessions.activate({ ...request, ...extra })).error.code, "VALIDATION_ERROR");
    assert.equal(s.clock.callbacks.size, 0);
  } finally { await s.root.dispose(); }
});
