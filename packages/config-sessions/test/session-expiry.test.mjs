import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOverrideSessionProvider,
  overrideSessionControllerSchema,
  overrideSessionProviderOptionsSchema,
  sessionExpiryIntentSchema,
} from "../dist/index.js";
import { sessionActivationRequestSchema, captureServiceData, writeResultSchema } from "@weaver-conf/config-types";
import { ManualClock } from "./manual-clock.mjs";

function fixture(options = {}) {
  const clock = new ManualClock();
  const intents = [];
  const controller = createOverrideSessionProvider({
    now: clock.now, timer: clock, defaultDurationMs: 100,
    onExpiryRequested: (intent) => { intents.push(intent); }, ...options,
  });
  return { controller, clock, intents };
}

test("deadline denies writes and extensions before queued expiry clears entries", async () => {
  const { controller, clock, intents } = fixture();
  const rejected = await controller.provider.write("a", 0);
  assert.equal(rejected.success, false);
  const captured = captureServiceData(rejected);
  assert.equal(captured.success, true);
  assert.equal(writeResultSchema.safeParse(captured.value).success, true);
  assert.equal((await controller.provider.remove("a")).success, false);
  controller.activate({ reason: "test" });
  await controller.provider.write("a", 1);
  clock.time += 100;
  assert.equal(controller.getSession().isActive, false);
  assert.equal((await controller.provider.write("a", 2)).error.code, "SESSION_REQUIRED");
  assert.equal((await controller.provider.remove("a")).success, false);
  assert.throws(() => controller.extend(), /No active session/);
  clock.fire();
  assert.equal(intents.length, 1);
  assert.equal(sessionExpiryIntentSchema.safeParse(intents[0]).success, true);
  assert.deepEqual((await controller.provider.load()).entries, { a: 1 });
  assert.equal(controller.commitExpiry(intents[0]), true);
  assert.deepEqual((await controller.provider.load()).entries, {});
  assert.equal(controller.commitExpiry(intents[0]), false);
});

test("early wake rearms remaining lease; stale callback after extend cannot cancel current timer", async () => {
  const { controller, clock, intents } = fixture();
  controller.activate({ reason: "test" });
  await controller.provider.write("a", 1);
  clock.time += 20;
  clock.fire(0);
  assert.equal(clock.delay, 80);
  assert.equal(intents.length, 0);
  clock.fire(0);
  assert.equal(clock.tasks.size, 1);
  controller.extend(200);
  clock.fire(0);
  clock.fire(1);
  assert.equal(controller.isActive(), true);
  assert.equal(clock.tasks.size, 1);
  assert.equal(clock.delay, 200);
  assert.deepEqual((await controller.provider.load()).entries, { a: 1 });
  clock.time += 200;
  clock.fire();
  assert.equal(intents.length, 1);
  assert.equal(controller.commitExpiry(intents[0]), true);
});

test("old intent cannot expire replacement or an extended session", () => {
  const { controller, clock, intents } = fixture();
  const first = controller.activate({ reason: "test" });
  const old = { sessionId: first.id, expiresAt: Date.parse(first.expiresAt), lease: 1 };
  assert.equal(controller.commitExpiry(old), false);
  controller.extend(200);
  clock.time += 100;
  assert.equal(controller.commitExpiry(old), false);
  controller.deactivate();
  const next = controller.activate({ reason: "replacement" });
  clock.fire(0);
  assert.equal(intents.length, 0);
  assert.equal(controller.commitExpiry(old), false);
  assert.equal(controller.getSession().id, next.id);
  controller.dispose();
});

test("invalid clock fails closed without changing storage until checked cleanup", async () => {
  const { controller, clock, intents } = fixture();
  controller.activate({ reason: "test" });
  await controller.provider.write("a", 1);
  clock.time = Number.NaN;
  assert.equal(controller.isActive(), false);
  assert.equal((await controller.provider.write("a", 2)).success, false);
  assert.throws(() => controller.extend(), /No active session/);
  clock.fire();
  assert.deepEqual((await controller.provider.load()).entries, { a: 1 });
  assert.equal(controller.commitExpiry(intents[0]), true);
  assert.deepEqual((await controller.provider.load()).entries, {});
});

test("invalid durations/options/activation do not schedule or mutate", () => {
  const { controller, clock } = fixture();
  for (const durationMs of [0, -1, 0.5, Number.NaN, Infinity, 2147483648]) {
    assert.throws(() => controller.activate({ reason: "test", durationMs }));
    assert.equal(controller.getSession(), null);
    assert.equal(clock.tasks.size, 0);
  }
  assert.throws(() => createOverrideSessionProvider({ defaultDurationMs: 101, maxDurationMs: 100 }));
  assert.throws(() => controller.activate({ reason: " " }));
  assert.throws(() => controller.activate({ reason: "test", elevatedAuth: { token: "x", method: "x" } }));
  controller.activate({ reason: "test" });
  const before = controller.getSession();
  assert.throws(() => controller.extend(0));
  assert.deepEqual(controller.getSession(), before);
  assert.equal(clock.callbacks.length, 1);
  controller.dispose();
});

test("configured maximum and native timer maximum are enforced", () => {
  const { controller, clock } = fixture({ maxDurationMs: 200 });
  assert.throws(() => controller.activate({ reason: "test", durationMs: 201 }));
  controller.activate({ reason: "test", durationMs: 200 });
  assert.throws(() => controller.extend(201));
  assert.equal(clock.delay, 200);
  controller.dispose();
  const large = fixture({ defaultDurationMs: 2147483647 });
  large.controller.activate({ reason: "long" });
  assert.equal(large.clock.delay, 2147483647);
  large.controller.dispose();
});

test("invalid clock at activation performs no scheduling", () => {
  for (const now of [() => NaN, () => Infinity, () => -1, () => 0.5, () => { throw Error("clock"); }]) {
    const { controller, clock } = fixture({ now });
    assert.throws(() => controller.activate({ reason: "test" }));
    assert.equal(clock.tasks.size, 0);
    assert.equal(controller.getSession(), null);
  }
});

test("audit exceptions cannot interrupt activation/extension/deactivation/disposal/expiry", async () => {
  for (const action of ["deactivate", "dispose", "expire"]) {
    const { controller, clock } = fixture({ onExpiryRequested: undefined, onAudit() { throw Error("audit"); } });
    controller.activate({ reason: "test" });
    controller.extend(100);
    assert.equal(clock.tasks.size, 1);
    await controller.provider.write("a", 1);
    if (action === "deactivate") assert.equal(controller.deactivate().auditRecorded, false);
    else if (action === "dispose") controller.dispose();
    else { clock.time += 100; clock.fire(); }
    assert.equal(controller.getSession(), null);
    assert.equal(clock.tasks.size, 0);
    assert.deepEqual((await controller.provider.load()).entries, {});
  }
});

test("reserved/malformed paths and getter-backed values reject with zero effects", async () => {
  const { controller } = fixture();
  controller.activate({ reason: "test" });
  await controller.provider.write("a", 1);
  for (const path of ["__proto__.polluted", "constructor.x", "a.prototype.x", "a..b", ""]) {
    assert.equal((await controller.provider.write(path, 1)).success, false);
    assert.equal((await controller.provider.remove(path)).success, false);
  }
  let reads = 0;
  const value = { get x() { reads++; return 1; } };
  assert.equal((await controller.provider.write("getter", value)).success, false);
  assert.equal(reads, 0);
  assert.deepEqual((await controller.provider.load()).entries, { a: 1 });
  assert.equal({}.polluted, undefined);
  controller.dispose();
});

test("domain schemas validate real native controller and class timer without stripping receiver", () => {
  const { controller, clock } = fixture();
  assert.equal(overrideSessionControllerSchema.safeParse(controller).success, true);
  assert.equal(overrideSessionProviderOptionsSchema.safeParse({ timer: clock }).success, true);
  assert.equal(sessionActivationRequestSchema.safeParse({ reason: "test", mode: "god-mode" }).success, false);
  assert.equal(overrideSessionControllerSchema.safeParse({}).success, false);
  controller.activate({ reason: "test" });
  assert.equal(clock.tasks.size, 1);
  controller.dispose();
});

test("rejected async audit and expiry callbacks are contained without false audit acknowledgement", async () => {
  const { controller, clock } = fixture({
    onAudit: async () => { throw Error("observer rejected"); },
    onExpiryRequested: async () => { throw Error("queue bridge rejected"); },
  });
  controller.activate({ reason: "test" });
  await controller.provider.write("a", 1);
  clock.time += 100;
  clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isActive(), false);
  assert.deepEqual((await controller.provider.load()).entries, { a: 1 });
  assert.equal(controller.deactivate().auditRecorded, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await controller.provider.load()).entries, {});
});

test("native timer requests expiry and checked commit clears standalone storage", async () => {
  let request;
  const requested = new Promise((resolve) => { request = resolve; });
  const controller = createOverrideSessionProvider({
    defaultDurationMs: 10,
    onExpiryRequested: (intent) => { request(intent); },
  });
  try {
    controller.activate({ reason: "native timer" });
    const intent = await requested;
    assert.equal(controller.isActive(), false);
    assert.equal(controller.commitExpiry(intent), true);
    assert.equal(controller.getSession(), null);
  } finally {
    controller.dispose();
  }
});
