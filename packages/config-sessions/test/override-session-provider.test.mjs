import assert from "node:assert/strict";
import { test } from "node:test";
import { createOverrideSessionProvider } from "../dist/index.js";
import { ManualClock } from "./manual-clock.mjs";

function fixture(options = {}) {
  const clock = new ManualClock();
  const audits = [];
  const controller = createOverrideSessionProvider({
    now: clock.now, timer: clock, onAudit: (entry) => { audits.push(entry); }, ...options,
  });
  return { controller, clock, audits };
}

test("activation metadata, default actor, empty overrides, query and eligibility", () => {
  const { controller, clock } = fixture();
  assert.equal(controller.getSession(), null);
  assert.equal(controller.isActive(), false);
  const session = controller.activate({ reason: "debugging" });
  assert.match(session.id, /^[0-9a-f-]{36}$/);
  assert.equal(session.activatedAt, new Date(clock.time).toISOString());
  assert.equal(session.expiresAt, new Date(clock.time + 14400000).toISOString());
  assert.equal(session.activatedBy, "system");
  assert.equal(session.reason, "debugging");
  assert.equal(session.isActive, true);
  assert.equal(controller.isActive(), true);
  assert.deepEqual(session.overrides, {});
  assert.deepEqual(controller.getSession(), session);
  assert.equal(clock.delay, 14400000);
  controller.dispose();
});

test("explicit actor and double activation rejection preserve current session", () => {
  const { controller } = fixture();
  const first = controller.activate({ activatedBy: "admin", reason: "test" });
  assert.equal(first.activatedBy, "admin");
  assert.throws(() => controller.activate({ reason: "again" }), /Session already active/);
  assert.deepEqual(controller.getSession(), first);
  controller.dispose();
});

test("inactive deactivate and extend reject", () => {
  const { controller } = fixture();
  assert.throws(() => controller.deactivate(), /No active session/);
  assert.throws(() => controller.extend(), /No active session/);
});

test("provider defaults and nested write/load/remove are the canonical storage dialect", async () => {
  const { controller } = fixture();
  controller.activate({ reason: "test" });
  const { provider } = controller;
  assert.equal(provider.id, "override-session");
  assert.equal(provider.layer, "session");
  assert.equal(provider.writable, true);
  assert.equal(typeof provider.write, "function");
  assert.equal(typeof provider.remove, "function");
  assert.equal((await provider.write("example.app.theme", "dark")).success, true);
  assert.deepEqual((await provider.load()).entries, { example: { app: { theme: "dark" } } });
  assert.equal((await provider.remove("example.app.theme")).success, true);
  assert.deepEqual((await provider.load()).entries, { example: { app: {} } });
  await provider.write("feature.x", true);
  assert.equal((await provider.load()).entries.feature.x, true);
  await provider.write("k", "v");
  assert.equal((await provider.remove("k")).success, true);
  assert.equal((await provider.load()).entries.k, undefined);
  controller.dispose();
});

test("custom provider ID and layer", () => {
  const { controller } = fixture({ layer: "custom-session", id: "my-session-provider" });
  controller.activate({ reason: "test" });
  assert.equal(controller.provider.id, "my-session-provider");
  assert.equal(controller.provider.layer, "custom-session");
  controller.dispose();
});

test("deactivate returns ID/time/count, clears storage and emits one audit", async () => {
  const { controller, clock, audits } = fixture();
  const session = controller.activate({ reason: "test" });
  await controller.provider.write("a", 1);
  await controller.provider.write("b", 2);
  await controller.provider.write("c", 3);
  assert.deepEqual(controller.getSession().overrides, { a: 1, b: 2, c: 3 });
  const result = controller.deactivate();
  assert.equal(result.sessionId, session.id);
  assert.equal(result.deactivatedAt, new Date(clock.time).toISOString());
  assert.equal(result.overridesCleared, 3);
  assert.equal(result.auditRecorded, true);
  assert.equal(controller.isActive(), false);
  assert.equal(controller.getSession(), null);
  assert.deepEqual((await controller.provider.load()).entries, {});
  assert.equal(clock.tasks.size, 0);
  assert.deepEqual(audits.map((a) => a.action), ["activate", "deactivate"]);
});

test("empty deactivation and absent audit report zero/false", () => {
  const { controller } = fixture({ onAudit: undefined });
  controller.activate({ reason: "test" });
  const result = controller.deactivate();
  assert.equal(result.overridesCleared, 0);
  assert.equal(result.auditRecorded, false);
});

test("custom activation duration, extension resets from now and defaults to current duration", () => {
  const { controller, clock } = fixture({ defaultDurationMs: 60000 });
  const original = controller.activate({ reason: "test", durationMs: 30000 });
  assert.equal(clock.delay, 30000);
  clock.time += 5000;
  const extended = controller.extend(120000);
  assert.equal(extended.id, original.id);
  assert.ok(Date.parse(extended.expiresAt) > Date.parse(original.expiresAt));
  assert.equal(Date.parse(extended.expiresAt), clock.time + 120000);
  assert.equal(clock.delay, 120000);
  assert.equal(clock.tasks.size, 1);
  clock.time += 100;
  assert.equal(Date.parse(controller.extend().expiresAt), clock.time + 120000);
  assert.equal(clock.delay, 120000);
  controller.dispose();
});

test("standalone deadline expiration clears values and records expire count", async () => {
  const { controller, clock, audits } = fixture({ defaultDurationMs: 5000 });
  controller.activate({ reason: "test" });
  await controller.provider.write("key", "value");
  clock.time += 5000;
  assert.equal(controller.isActive(), false);
  clock.fire();
  assert.equal(controller.getSession(), null);
  assert.deepEqual((await controller.provider.load()).entries, {});
  const event = audits.find((a) => a.action === "expire");
  assert.equal(event.details.overridesCleared, 1);
  assert.equal(event.timestamp, new Date(clock.time).toISOString());
});

test("all four audit actions, actor, session IDs, timestamps and reactivation", () => {
  const { controller, clock, audits } = fixture({ defaultDurationMs: 5000 });
  const first = controller.activate({ activatedBy: "admin", reason: "audit-test" });
  controller.extend(10000);
  controller.deactivate();
  const next = controller.activate({ reason: "expire-test" });
  assert.notEqual(next.id, first.id);
  clock.time += 5000;
  clock.fire();
  assert.deepEqual(audits.map((a) => a.action), ["activate", "extend", "deactivate", "activate", "expire"]);
  assert.equal(audits[0].actor, "admin");
  assert.equal(audits[0].sessionId, first.id);
  assert.equal(audits[0].details.reason, "audit-test");
  assert.ok(audits.every((a) => Number.isFinite(Date.parse(a.timestamp))));
});

test("dispose clears entries/timer, audits once and rejects reactivation", async () => {
  const { controller, clock, audits } = fixture();
  controller.activate({ reason: "test" });
  await controller.provider.write("k", "v");
  controller.dispose();
  controller.dispose();
  clock.fire();
  assert.equal(controller.isActive(), false);
  assert.equal(controller.getSession(), null);
  assert.equal(clock.tasks.size, 0);
  assert.equal(clock.cancelled.length, 1);
  assert.deepEqual((await controller.provider.load()).entries, {});
  assert.deepEqual(audits.map((a) => a.action), ["activate", "deactivate"]);
  assert.throws(() => controller.activate({ reason: "again" }), /disposed/);
});

test("nested inputs, arrays, load and metadata snapshots are detached", async () => {
  const { controller } = fixture();
  controller.activate({ reason: "test" });
  const value = { nested: [{ enabled: true }] };
  await controller.provider.write("[literal.dot].日本語", value);
  value.nested[0].enabled = false;
  const first = await controller.provider.load();
  first.entries["literal.dot"].日本語.nested.push("mutated");
  controller.getSession().overrides["literal.dot"].日本語.nested[0].enabled = false;
  assert.deepEqual((await controller.provider.load()).entries, {
    "literal.dot": { 日本語: { nested: [{ enabled: true }] } },
  });
  assert.equal((await controller.provider.remove("[literal.dot].日本語")).success, true);
  assert.deepEqual((await controller.provider.load()).entries, { "literal.dot": {} });
  controller.dispose();
});
