import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createOverrideSessionProvider } from "../dist/index.js";
import { ManualClock } from "./manual-clock.mjs";

const maximum = 2147483647;

test("maximum lease bounds initial scheduling after clock moves from 1000 to 999", () => {
  const clock = new ManualClock();
  let calls = 0;
  const controller = createOverrideSessionProvider({
    defaultDurationMs: maximum,
    timer: clock,
    now: () => ++calls === 1 ? 1000 : 999,
  });
  try {
    const info = controller.activate({ reason: "clock correction" });
    assert.equal(Date.parse(info.activatedAt), 1000);
    assert.equal(Date.parse(info.expiresAt), 1000 + maximum);
    assert.equal(clock.delay, maximum);
    assert.equal(clock.tasks.size, 1);
    assert.equal(controller.isActive(), true);
  } finally {
    controller.dispose();
  }
  assert.equal(clock.tasks.size, 0);
  assert.equal(clock.cancelled.length, 1);
});

test("backwards-clock early wakes bound every delay without changing deadline or lease", async () => {
  const clock = new ManualClock(), intents = [], audits = [];
  const controller = createOverrideSessionProvider({
    defaultDurationMs: maximum, timer: clock, now: clock.now,
    onExpiryRequested: (intent) => { intents.push(intent); },
    onAudit: (entry) => { audits.push(entry); },
  });
  try {
    const original = controller.activate({ reason: "clock correction" });
    const deadline = Date.parse(original.expiresAt);
    await controller.provider.write("app.enabled", true);
    assert.equal(clock.delay, maximum);
    clock.time = 999;
    clock.fire();
    assert.equal(clock.delay, maximum);
    clock.time = 998;
    clock.fire();
    assert.equal(clock.delay, maximum);
    assert.equal(clock.tasks.size, 1);
    assert.equal(controller.getSession().expiresAt, original.expiresAt);
    assert.equal(intents.length, 0);
    clock.time = deadline - 1;
    clock.fire();
    assert.equal(clock.delay, 1);
    assert.equal(controller.isActive(), true);
    assert.deepEqual((await controller.provider.load()).entries, { app: { enabled: true } });
    clock.time = deadline;
    assert.equal(controller.isActive(), false);
    assert.equal((await controller.provider.write("app.enabled", false)).success, false);
    clock.fire();
    clock.fire();
    assert.deepEqual(intents, [{ sessionId: original.id, expiresAt: deadline, lease: 1 }]);
    assert.deepEqual((await controller.provider.load()).entries, { app: { enabled: true } });
    assert.equal(controller.commitExpiry(intents[0]), true);
    assert.equal(controller.commitExpiry(intents[0]), false);
    assert.deepEqual((await controller.provider.load()).entries, {});
    assert.equal(audits.filter((entry) => entry.action === "expire").length, 1);
    assert.equal(clock.tasks.size, 0);
  } finally {
    controller.dispose();
  }
});

test("native maximum timeout with backward clock emits no warning or one-millisecond rearm", () => {
  const module = new URL("../dist/index.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { setTimeout as delay } from "node:timers/promises";
    import { createOverrideSessionProvider } from ${JSON.stringify(module)};
    let calls = 0;
    const controller = createOverrideSessionProvider({
      now: () => ++calls === 1 ? 1000 : 999,
      defaultDurationMs: ${maximum},
    });
    try {
      const info = controller.activate({ reason: "native clock correction" });
      assert.equal(Date.parse(info.expiresAt), 1000 + ${maximum});
      const scheduledCalls = calls;
      await delay(20);
      assert.equal(calls, scheduledCalls, "maximum timer must not wake and rearm at 1ms");
    } finally {
      controller.dispose();
    }
    assert.equal(controller.getSession(), null);
    console.log("native maximum timer disposed");
  `], { encoding: "utf8", timeout: 3000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.doesNotMatch(child.stderr, /TimeoutOverflowWarning/);
  assert.equal(child.stderr, "");
  assert.equal(child.stdout.trim(), "native maximum timer disposed");
});
test("queued current expiry that becomes early rearms exactly one timer with the same lease", async () => {
  const clock = new ManualClock(), intents = [], audits = [];
  const controller = createOverrideSessionProvider({
    defaultDurationMs: 100, timer: clock, now: clock.now,
    onExpiryRequested: (intent) => { intents.push(intent); },
    onAudit: (entry) => { audits.push(entry); },
  });
  try {
    const original = controller.activate({ reason: "queued clock correction" });
    const deadline = Date.parse(original.expiresAt);
    await controller.provider.write("app.enabled", true);
    clock.time = deadline; clock.fire();
    assert.equal(clock.tasks.size, 0); assert.equal(intents.length, 1);
    clock.time = deadline - 1;
    assert.equal(controller.commitExpiry(intents[0]), false);
    assert.equal(clock.tasks.size, 1); assert.equal(clock.delay, 1);
    const scheduled = clock.callbacks.length;
    assert.equal(controller.commitExpiry(intents[0]), false);
    assert.equal(clock.tasks.size, 1); assert.equal(clock.callbacks.length, scheduled);
    assert.equal(controller.getSession().id, original.id);
    assert.equal(controller.getSession().expiresAt, original.expiresAt);
    assert.deepEqual((await controller.provider.load()).entries, { app: { enabled: true } });
    assert.equal(audits.filter((entry) => entry.action === "expire").length, 0);
    clock.time = deadline; clock.fire();
    assert.deepEqual(intents, [intents[0], intents[0]]);
    assert.equal(intents[1].lease, 1);
    assert.equal((await controller.provider.write("app.enabled", false)).success, false);
    assert.deepEqual((await controller.provider.load()).entries, { app: { enabled: true } });
    assert.equal(controller.commitExpiry(intents[1]), true);
    assert.equal(controller.commitExpiry(intents[0]), false);
    assert.deepEqual((await controller.provider.load()).entries, {});
    assert.equal(audits.filter((entry) => entry.action === "expire").length, 1);
    assert.equal(clock.tasks.size, 0);
  } finally { controller.dispose(); }
});

test("stale queued intents cannot rearm extended, replaced, deactivated or disposed leases", async () => {
  for (const transition of ["extend", "replace", "deactivate", "dispose"]) {
    const clock = new ManualClock(), intents = [];
    const controller = createOverrideSessionProvider({
      defaultDurationMs: 100, timer: clock, now: clock.now,
      onExpiryRequested: (intent) => { intents.push(intent); },
    });
    try {
      const original = controller.activate({ reason: "old lease" });
      clock.time = Date.parse(original.expiresAt); clock.fire();
      clock.time--;
      if (transition === "extend") controller.extend(100);
      else if (transition === "dispose") controller.dispose();
      else {
        controller.deactivate();
        if (transition === "replace") controller.activate({ reason: "replacement" });
      }
      if (controller.isActive()) await controller.provider.write("app.enabled", true);
      const current = controller.getSession(), entries = await controller.provider.load();
      const pending = clock.tasks.size, scheduled = clock.callbacks.length;
      assert.equal(controller.commitExpiry(intents[0]), false, transition);
      assert.equal(clock.tasks.size, pending, transition);
      assert.equal(clock.callbacks.length, scheduled, transition);
      assert.deepEqual(controller.getSession(), current, transition);
      assert.deepEqual(await controller.provider.load(), entries, transition);
    } finally { controller.dispose(); }
    assert.equal(clock.tasks.size, 0);
  }
});
