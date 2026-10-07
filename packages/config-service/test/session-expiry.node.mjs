import assert from "node:assert/strict";
import { test } from "node:test";
import { commands, WritableMemory } from "./fixtures/writable-memory.mjs";
import { sessionHost, SessionClock } from "./fixtures/session-host.mjs";

const command = (s, id, value) => commands(s.input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: id, value });

test("expiry during full-prefix authorization rejects even an earlier persistent command before effects", async () => {
  const clock = new SessionClock();
  const s = await sessionHost({ clock, host: { hostAuthority: {
    authorizeReadSync() { return "allowed"; },
    async authorizeWrite(_principal, request) {
      if (request.operation === "write" && request.sessionId) { await Promise.resolve(); clock.time += 100; }
      return "allowed";
    },
  } } });
  try {
    const info = (await s.activate()).value;
    const revision = s.reader.revision;
    const result = await s.mutations.apply([
      ...commands(s.input, { operation: "set", path: "/alpha/flag", value: "persistent forbidden prefix" }),
      ...command(s, info.id, "expired"),
    ]);
    assert.equal(result.outcome, "rejected"); assert.equal(s.provider.writes, 0);
    assert.equal(s.reader.revision, revision); assert.equal(s.reader.get(["flag"]), "before");
  } finally { await s.root.dispose(); }
});

test("deadline during accepted persistent IO preserves receipts and serializes fallback after that publication", async () => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  class BlockingMemory extends WritableMemory {
    async write(key, value) { entered(); await gate; return super.write(key, value); }
  }
  const s = await sessionHost({ provider: new BlockingMemory() });
  try {
    const a = (await s.activate()).value;
    assert.equal((await s.mutations.apply(command(s, a.id, "temporary"))).success, true);
    const events = []; s.reader.onChange(["flag"], (event) => events.push(event));
    const pending = s.mutations.apply([
      ...command(s, a.id, "accepted temporary"),
      ...commands(s.input, { operation: "set", path: "/alpha/flag", value: "accepted persistent" }),
      ...command(s, a.id, "must not dispatch"),
    ]);
    await started;
    s.clock.time += 100; s.clock.fire();
    assert.equal(s.sessions.get(a.id), null);
    assert.equal(s.reader.get(["flag"]), "temporary");
    assert.equal((await s.mutations.apply(command(s, a.id, "new late request"))).success, false);
    release();
    const result = await pending;
    assert.equal(result.outcome, "partial", JSON.stringify(result));
    assert.deepEqual(result.results.map((r) => r.effect), ["committed", "committed", "rejected"]);
    await s.root.flush();
    assert.equal(s.reader.get(["flag"]), "accepted persistent");
    assert.equal(s.provider.writes, 1);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.current.value), ["accepted temporary", "accepted persistent"]);
  } finally { await s.root.dispose(); }
});

test("creator TTL caps activation/extension and independent observer sees one expiry fallback", async () => {
  const s = await sessionHost();
  try {
    const creator = s.controller.mint({ ...s.claims, expiresAt: s.clock.time + 80 });
    const sessions = s.controller.forSessions(creator), writes = s.controller.forMutations(creator);
    const created = await sessions.activate({ identity: s.input.identity, namespace: "/alpha", reason: "bounded", emergency: false, durationMs: 200 });
    assert.equal(created.ok, true); assert.equal(created.value.expiresAt, s.clock.time + 80);
    assert.equal((await writes.apply(command(s, created.value.id, "temporary"))).success, true);
    const creatorReader = s.controller.forIdentity(creator, { identity: s.input.identity, namespace: "/alpha" });
    const creatorEvents = []; creatorReader.onChange(["flag"], (event) => creatorEvents.push(event));
    assert.equal((await sessions.extend({ sessionId: created.value.id, durationMs: 500 })).value.expiresAt, s.clock.time + 80);
    const events = []; s.reader.onChange(["flag"], (event) => events.push(event));
    s.clock.time += 80;
    assert.equal((await writes.apply(command(s, created.value.id, "late"))).success, false);
    assert.throws(() => sessions.list(), { code: "FORBIDDEN" });
    assert.equal(s.reader.get(["flag"]), "temporary");
    s.clock.fire(); await s.root.flush();
    assert.equal(s.reader.get(["flag"]), "before"); assert.equal(events.length, 1);
    assert.equal(creatorEvents.length, 0);
    assert.equal(events[0].cause, "session");
  } finally { await s.root.dispose(); }
});

test("integer session leases conservatively cap fractional principal expiry", async () => {
  const s = await sessionHost();
  try {
    const token = s.controller.mint({ ...s.claims, expiresAt: s.clock.time + 80.75 });
    const sessions = s.controller.forSessions(token);
    const created = await sessions.activate({ identity: s.input.identity, namespace: "/alpha", reason: "fractional cap", emergency: false, durationMs: 200 });
    assert.equal(created.ok, true); assert.equal(created.value.expiresAt, s.clock.time + 80);
    assert.equal((await sessions.extend({ sessionId: created.value.id, durationMs: 500 })).value.expiresAt, s.clock.time + 80);
  } finally { await s.root.dispose(); }
});

test("revoke immediately denies new session dispatch and publishes fallback once with isolated audit", async () => {
  const records = [];
  const s = await sessionHost({ host: { audit(record) { records.push(record); if (record.request.operation === "session-deactivate") throw Error("audit"); } } });
  try {
    const info = (await s.activate()).value;
    await s.mutations.apply(command(s, info.id, "temporary"));
    const observer = s.controller.forIdentity(s.controller.mint(s.claims), { identity: s.input.identity, namespace: "/alpha" });
    const events = []; observer.onChange(["flag"], (event) => events.push(event));
    s.controller.revoke(s.token);
    assert.equal((await s.mutations.apply(command(s, info.id, "late"))).success, false);
    await s.root.flush();
    assert.equal(observer.get(["flag"]), "before"); assert.equal(events.length, 1);
    assert.equal(s.clock.callbacks.size, 0);
    assert.equal(records.filter((r) => r.request.operation === "session-deactivate").length, 1);
    assert.equal(records.find((r) => r.request.operation === "session-deactivate").request.cause, "revoked");
  } finally { await s.root.dispose(); }
});
test("queued expiry after blocked IO rearms on clock rollback and eventually publishes one fallback", async () => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  class BlockingMemory extends WritableMemory {
    async write(key, value) { entered(); await gate; return super.write(key, value); }
  }
  const records = [];
  const s = await sessionHost({ provider: new BlockingMemory(), host: { audit(record) { records.push(record); } } });
  const expired = () => records.filter((record) => record.phase === "committed" && record.request.operation === "session-deactivate" && record.request.cause === "expired");
  try {
    const info = (await s.activate()).value;
    assert.equal((await s.mutations.apply(command(s, info.id, "temporary"))).success, true);
    const events = []; s.reader.onChange(["flag"], (event) => events.push(event));
    const pending = s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", value: "persistent" }));
    await started;
    s.clock.time = info.expiresAt; s.clock.fire();
    assert.equal(s.clock.callbacks.size, 0);
    s.clock.time = info.expiresAt - 1;
    release();
    const result = await pending;
    assert.equal(result.success, true); assert.equal(result.results[0].effect, "committed");
    await s.root.flush();
    assert.equal(s.reader.get(["flag"]), "temporary");
    assert.equal(s.sessions.get(info.id).expiresAt, info.expiresAt);
    assert.equal(s.clock.callbacks.size, 1);
    assert.equal([...s.clock.callbacks.values()][0].ms, 1);
    assert.equal(events.length, 0); assert.equal(expired().length, 0);
    s.clock.time = info.expiresAt + 100;
    assert.equal(s.sessions.get(info.id), null);
    assert.equal((await s.mutations.apply(command(s, info.id, "late"))).success, false);
    s.clock.fire(); await s.root.flush();
    assert.deepEqual(s.reader.snapshot(["flag"]).value, { state: "value", value: "persistent" });
    assert.equal(s.clock.callbacks.size, 0);
    assert.equal(events.length, 1); assert.equal(events[0].cause, "session");
    assert.equal(events[0].current.value, "persistent"); assert.equal(expired().length, 1);
    assert.equal(s.provider.writes, 1); assert.equal(s.provider.flushes, 0);
    assert.equal(s.root.mode, "live");
  } finally { release(); await s.root.dispose(); }
  assert.equal(s.clock.callbacks.size, 0);
});
