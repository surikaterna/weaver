import { writable, WritableMemory, writableOptions } from "./writable-memory.mjs";
import { principal, authConfig } from "./authority.mjs";

export class SessionClock {
  time = 1000; callbacks = new Map(); count = 0;
  now = () => this.time;
  setTimeout(fn, ms) { const id = ++this.count; this.callbacks.set(id, { fn, ms }); return id; }
  clearTimeout(id) { this.callbacks.delete(id); }
  fire() { const tasks = [...this.callbacks.values()]; this.callbacks.clear(); for (const task of tasks) task.fn(); }
}

export async function sessionHost({ provider = new WritableMemory(), input = writableOptions([provider]), claims, host = {}, clock = new SessionClock() } = {}) {
  if (!input.layers.some((slot) => slot.kind === "session")) input.layers.push({ kind: "session", layer: "incident" });
  claims ??= principal(input, { sessionPermissions: ["read", "activate", "extend", "deactivate", "emergency"] });
  const value = await writable({ provider, input, claims, host: {
    now: clock.now,
    sessions: { defaultDurationMs: 100, maxDurationMs: 1000, maxActiveSessions: 10, timer: clock },
    authConfig: { ...authConfig(input), sessionLayer: "incident", elevatedSessionMode: "emergency-override" },
    ...host,
  } });
  const sessions = value.controller.forSessions(value.token);
  const activate = (overrides = {}) => sessions.activate({ identity: input.identity, namespace: "/alpha", reason: "investigate", emergency: false, ...overrides });
  return { ...value, clock, claims, sessions, activate };
}
