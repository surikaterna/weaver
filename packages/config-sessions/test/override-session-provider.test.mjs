import { createOverrideSessionProvider } from "../src/override-session-provider.ts";

// Fake timer that allows manual triggering of scheduled callbacks
function createFakeTimer() {
  let callback = null;
  let scheduledMs = null;
  let cleared = false;
  let timeoutId = 1;

  return {
    impl: {
      setTimeout(fn, ms) {
        callback = fn;
        scheduledMs = ms;
        cleared = false;
        return timeoutId++;
      },
      clearTimeout(_id) {
        callback = null;
        scheduledMs = null;
        cleared = true;
      },
    },
    fire() {
      if (callback !== null && !cleared) {
        const fn = callback;
        callback = null;
        fn();
      }
    },
    get scheduledMs() {
      return scheduledMs;
    },
    get wasCleared() {
      return cleared;
    },
  };
}

test("activate creates session with correct metadata", () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  const session = controller.activate({ reason: "debugging" });

  expect(session.id).toBeTruthy();
  expect(session.activatedAt).toBeTruthy();
  expect(session.expiresAt).toBeTruthy();
  expect(session.activatedBy).toBe("system");
  expect(session.reason).toBe("debugging");
  expect(session.isActive).toBe(true);
  expect(session.overrides).toEqual({});

  controller.dispose();
});

test("activate rejects when session already active", () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  controller.activate({ reason: "first" });

  expect(() => controller.activate({ reason: "second" })).toThrow(
    "Session already active",
  );

  controller.dispose();
});

test("deactivate clears overrides and returns count", async () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
    onAudit: () => {},
  });

  controller.activate({ reason: "test" });
  await controller.provider.write("key1", "val1");
  await controller.provider.write("key2", "val2");

  const result = controller.deactivate();

  expect(result.overridesCleared).toBe(2);
  expect(result.sessionId).toBeTruthy();
  expect(result.deactivatedAt).toBeTruthy();
  expect(result.auditRecorded).toBe(true);

  // Storage should be empty after deactivation
  const data = await controller.provider.load();
  expect(data.entries).toEqual({});
});

test("deactivate rejects when no active session", () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  expect(() => controller.deactivate()).toThrow("No active session");
});

test("extend resets timer and updates expiresAt", () => {
  const fakeTimer = createFakeTimer();
  const controller = createOverrideSessionProvider({
    timer: fakeTimer.impl,
    defaultDurationMs: 60_000,
  });

  const original = controller.activate({ reason: "test" });
  const originalExpires = new Date(original.expiresAt).getTime();

  // Extend with a longer duration
  const extended = controller.extend(120_000);
  const extendedExpires = new Date(extended.expiresAt).getTime();

  expect(extendedExpires > originalExpires).toBeTruthy();
  expect(extended.id).toBe(original.id);

  controller.dispose();
});

test("extend rejects when no active session", () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  expect(() => controller.extend()).toThrow("No active session");
});

test("provider implements ConfigurationStorageProvider (read/write/remove)", async () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  controller.activate({ reason: "test" });

  const { provider } = controller;

  // Verify provider interface — defaults
  expect(provider.id).toBe("override-session");
  expect(provider.layer).toBe("session");
  expect(provider.writable).toBe(true);

  // Write
  const writeResult = await provider.write("ghost.app.theme", "dark");
  expect(writeResult.success).toBe(true);

  // Read
  const data = await provider.load();
  expect(data.entries.ghost.app.theme).toBe("dark");

  // Remove
  const removeResult = await provider.remove("ghost.app.theme");
  expect(removeResult.success).toBe(true);

  const dataAfter = await provider.load();
  expect(dataAfter.entries.ghost.app).toEqual({});

  controller.dispose();
});

test("session overrides are cleared on deactivate", async () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  controller.activate({ reason: "test" });
  await controller.provider.write("a", 1);
  await controller.provider.write("b", 2);
  await controller.provider.write("c", 3);

  // Session should track overrides
  const session = controller.getSession();
  expect(session.overrides).toEqual({ a: 1, b: 2, c: 3 });

  controller.deactivate();

  // Provider storage should be empty
  const data = await controller.provider.load();
  expect(data.entries).toEqual({});
});

test("auto-expire triggers deactivation after timer fires", async () => {
  const fakeTimer = createFakeTimer();
  const auditLog = [];
  const controller = createOverrideSessionProvider({
    timer: fakeTimer.impl,
    defaultDurationMs: 5_000,
    onAudit: (entry) => auditLog.push(entry),
  });

  controller.activate({ reason: "test" });
  await controller.provider.write("key", "value");

  expect(controller.isActive()).toBe(true);

  // Fire the expiration timer
  fakeTimer.fire();

  expect(controller.isActive()).toBe(false);
  expect(controller.getSession()).toBe(null);

  // Storage should be cleared
  const data = await controller.provider.load();
  expect(data.entries).toEqual({});

  // Should have emitted expire audit
  const expireEvent = auditLog.find((e) => e.action === "expire");
  expect(expireEvent).toBeTruthy();
  expect(expireEvent.details.overridesCleared).toBe(1);
});

test("audit events emitted for activate/deactivate/extend/expire", async () => {
  const fakeTimer = createFakeTimer();
  const auditLog = [];
  const controller = createOverrideSessionProvider({
    timer: fakeTimer.impl,
    defaultDurationMs: 5_000,
    onAudit: (entry) => auditLog.push(entry),
  });

  // activate
  controller.activate({ reason: "audit-test" });
  expect(auditLog.length).toBe(1);
  expect(auditLog[0].action).toBe("activate");
  expect(auditLog[0].sessionId).toBeTruthy();
  expect(auditLog[0].timestamp).toBeTruthy();

  // extend
  controller.extend(10_000);
  expect(auditLog.length).toBe(2);
  expect(auditLog[1].action).toBe("extend");

  // deactivate
  controller.deactivate();
  expect(auditLog.length).toBe(3);
  expect(auditLog[2].action).toBe("deactivate");

  // Re-activate then expire
  controller.activate({ reason: "expire-test" });
  fakeTimer.fire();
  expect(auditLog.length).toBe(5); // +activate, +expire
  expect(auditLog[4].action).toBe("expire");
});

test("dispose clears timer and deactivates", async () => {
  const fakeTimer = createFakeTimer();
  const auditLog = [];
  const controller = createOverrideSessionProvider({
    timer: fakeTimer.impl,
    onAudit: (entry) => auditLog.push(entry),
  });

  controller.activate({ reason: "test" });
  await controller.provider.write("k", "v");

  controller.dispose();

  expect(controller.isActive()).toBe(false);
  expect(controller.getSession()).toBe(null);

  // Should have emitted deactivate audit
  const deactivateEvent = auditLog.find((e) => e.action === "deactivate");
  expect(deactivateEvent).toBeTruthy();

  // Timer should not fire after dispose (fire should be no-op)
  fakeTimer.fire();
  expect(controller.isActive()).toBe(false);
});

test("custom durationMs in activation request", () => {
  const fakeTimer = createFakeTimer();
  const controller = createOverrideSessionProvider({
    timer: fakeTimer.impl,
    defaultDurationMs: 60_000,
  });

  controller.activate({ reason: "custom", durationMs: 30_000 });

  expect(fakeTimer.scheduledMs).toBe(30_000);

  controller.dispose();
});

test("getSession returns null when no session, returns session when active", () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  expect(controller.getSession()).toBe(null);

  controller.activate({ reason: "test" });

  const session = controller.getSession();
  expect(session !== null).toBeTruthy();
  expect(session.reason).toBe("test");
  expect(session.isActive).toBe(true);

  controller.dispose();
});

test("default duration is 4 hours", () => {
  const fakeTimer = createFakeTimer();
  const controller = createOverrideSessionProvider({
    timer: fakeTimer.impl,
  });

  controller.activate({ reason: "test" });

  expect(fakeTimer.scheduledMs).toBe(4 * 60 * 60 * 1000);

  controller.dispose();
});

test("deactivate returns auditRecorded false when no onAudit", () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  controller.activate({ reason: "test" });
  const result = controller.deactivate();

  expect(result.auditRecorded).toBe(false);
});

test("provider load returns snapshot (not live reference)", async () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
  });

  controller.activate({ reason: "test" });
  await controller.provider.write("nested.key", "value");

  const data1 = await controller.provider.load();
  data1.entries.nested.key = "mutated";

  const data2 = await controller.provider.load();
  expect(data2.entries.nested.key).toBe("value");

  controller.dispose();
});

test("extend without duration uses current duration", () => {
  const fakeTimer = createFakeTimer();
  const controller = createOverrideSessionProvider({
    timer: fakeTimer.impl,
    defaultDurationMs: 60_000,
  });

  controller.activate({ reason: "test", durationMs: 30_000 });
  expect(fakeTimer.scheduledMs).toBe(30_000);

  // Extend without specifying duration should use the current (30s)
  controller.extend();
  expect(fakeTimer.scheduledMs).toBe(30_000);

  controller.dispose();
});

test("custom layer and id options", () => {
  const controller = createOverrideSessionProvider({
    timer: createFakeTimer().impl,
    layer: "custom-session",
    id: "my-session-provider",
  });

  controller.activate({ reason: "test" });

  const { provider } = controller;
  expect(provider.id).toBe("my-session-provider");
  expect(provider.layer).toBe("custom-session");

  controller.dispose();
});
