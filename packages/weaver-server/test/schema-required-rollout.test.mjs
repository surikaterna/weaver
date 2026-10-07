import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createHmac } from "node:crypto";
import { get as httpGet } from "node:http";
import { startWeaverServer } from "../src/server.ts";

const owner = { name: "Billing", contact: "billing@example.com" };
const schema = {
  type: "object",
  properties: {
    mode: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    plugins: {
      type: "object",
      properties: { tax: { type: "object", properties: { enabled: { type: "boolean" }, source: { type: "string", const: "safe" } }, additionalProperties: true } },
      additionalProperties: false,
    },
  },
  additionalProperties: true,
};

function provider(entries = {}) {
  const storage = createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: entries });
  const effects = {
    writes: vi.spyOn(storage, "write"),
    removes: vi.spyOn(storage, "remove"),
    flushes: vi.fn(async () => {}),
  };
  storage.flush = effects.flushes;
  storage.dirty = true;
  return { storage, effects };
}

function counts(effects) {
  return [effects.writes.mock.calls.length, effects.removes.mock.calls.length, effects.flushes.mock.calls.length];
}

async function watchDeltas(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpGet(`http://localhost:${port}/v1/events`, { headers }, (response) => {
      let messages = "";
      response.on("data", (chunk) => {
        messages += chunk.toString();
        if (messages.includes("event: snapshot")) resolve({ changes: () => (messages.match(/event: change/g) ?? []).length, close: () => req.destroy() });
      });
      response.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function denied(port, storage, effects, deltas, path, method, body, code, status = 400, auth = {}) {
  const entries = structuredClone((await storage.load()).entries);
  const revision = (await request(port, "/v1/config", "GET", undefined, auth.read)).body.meta.revision;
  const before = counts(effects);
  const changes = deltas.changes();
  const result = await request(port, path, method, body, auth.write);
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.body.error.code).toBe(code);
  expect(result.body.meta.revision).toBe(status === 403 ? "" : revision);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await request(port, "/v1/config", "GET", undefined, auth.read)).body.meta.revision).toBe(revision);
  expect((await storage.load()).entries).toEqual(entries);
  expect(counts(effects)).toEqual(before);
  expect(deltas.changes()).toBe(changes);
}

async function request(port, path, method = "GET", body, headers = {}) {
  const response = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function token(secret, role) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: role, roles: [role] })).toString("base64url");
  const value = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(value).digest("base64url");
  return { Authorization: `Bearer ${value}.${signature}` };
}

async function register(port, serviceSchema = schema) {
  return request(port, "/v1/admin/schemas/services", "POST", {
    serviceId: "billing", environment: "development", owner, schema: serviceSchema,
    fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
  });
}

describe("schema-required rollout across public readiness and restart", () => {
  test("known empty persistence rejects seed writes until registration; restart preserves both authority and data", async () => {
    const { storage, effects } = provider();
    const first = await startWeaverServer({ port: 0, providers: [storage] });
    const deltas = await watchDeltas(first.port);
    try {
      expect((await request(first.port, "/readyz")).status).toBe(200);
      await denied(first.port, storage, effects, deltas, "/v1/config/billing", "PUT", { value: { mode: "early" } }, "SCHEMA_NOT_REGISTERED");
      expect((await storage.load()).entries).toEqual({});
      expect((await register(first.port)).status).toBe(201);
      expect((await request(first.port, "/v1/config/billing", "PUT", { value: { mode: "seed", items: ["one"] } })).status).toBe(200);
    } finally {
      deltas.close();
      await first.close();
    }
    const second = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      expect((await request(second.port, "/readyz")).status).toBe(200);
      expect((await request(second.port, "/v1/config/billing/mode")).body.data.value).toBe("seed");
      expect((await request(second.port, "/v1/config/billing/mode", "PUT", { value: "after" })).status).toBe(200);
      expect((await storage.load()).entries.billing).toEqual({ mode: "after", items: ["one"] });
    } finally {
      await second.close();
    }
  });

  test.each([true, undefined])("restart retains explicit wildcard declarations versus omitted additionalProperties=%s", async (additional) => {
    const { storage, effects } = provider({ billing: { mode: "old", rogue: "keep", items: ["one"] }, old: { key: "keep" } });
    const first = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      expect((await register(first.port, { ...schema, ...(additional === undefined ? { additionalProperties: undefined } : { additionalProperties: additional }) })).status).toBe(201);
    } finally {
      await first.close();
    }
    const second = await startWeaverServer({ port: 0, providers: [storage] });
    const deltas = await watchDeltas(second.port);
    try {
      for (const path of ["billing/rogue", "old/key"]) {
        for (const method of ["PUT", "DELETE"]) {
          if (additional === true && path === "billing/rogue") {
            expect((await request(second.port, `/v1/config/${path}`, method, method === "PUT" ? { value: "changed" } : undefined)).status).toBe(200);
            expect((await storage.load()).entries.billing.rogue).toBe(method === "PUT" ? "changed" : undefined);
          } else {
            await denied(second.port, storage, effects, deltas, `/v1/config/${path}`, method, method === "PUT" ? { value: "changed" } : undefined, "SCHEMA_NOT_REGISTERED");
          }
        }
      }
      expect((await storage.load()).entries.billing.items).toEqual(["one"]);
      expect((await storage.load()).entries.billing.rogue).toBe(additional === true ? undefined : "keep");
      expect((await storage.load()).entries.old.key).toBe("keep");
    } finally {
      deltas.close();
      await second.close();
    }
  });

  test("rehydrated pattern, schema-valued wildcard, fragment and array declarations constrain public writes", async () => {
    const { storage, effects } = provider();
    const dynamic = {
      type: "object",
      properties: schema.properties,
      patternProperties: { "^flag_": { type: "boolean" } },
      additionalProperties: { type: "object", properties: { value: { type: "integer" } }, additionalProperties: false },
    };
    const first = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      expect((await register(first.port, dynamic)).status).toBe(201);
      const fragment = await request(first.port, "/v1/admin/schemas/fragments", "POST", {
        serviceId: "billing", providerId: "tax", slotPath: "/plugins", environment: "development", owner,
        schema: { type: "object", properties: { enabled: { type: "boolean" }, source: { type: "string" } }, additionalProperties: false },
      });
      expect(fragment.status).toBe(201);
    } finally {
      await first.close();
    }
    const second = await startWeaverServer({ port: 0, providers: [storage] });
    const deltas = await watchDeltas(second.port);
    try {
      const put = (path, value) => request(second.port, `/v1/config/${path}`, "PUT", { value });
      const flag = await put("billing/flag_live", true);
      expect(flag.status, JSON.stringify(flag.body)).toBe(200);
      expect((await put("billing/custom", { value: 1 })).status).toBe(200);
      expect((await put("billing/items", ["one"])).status).toBe(200);
      expect((await put("billing/plugins/tax", { enabled: true })).status).toBe(200);
      expect(deltas.changes()).toBeGreaterThan(0);
      await denied(second.port, storage, effects, deltas, "/v1/config/billing/custom", "PUT", { value: { value: 1, extra: "bad" } }, "SCHEMA_NOT_REGISTERED");
      await denied(second.port, storage, effects, deltas, "/v1/config/billing/plugins/tax", "PUT", { value: { enabled: true, rogue: 1 } }, "SCHEMA_NOT_REGISTERED");
      await denied(second.port, storage, effects, deltas, "/v1/config/billing/plugins/tax", "PUT", { value: { enabled: true, source: "unsafe" } }, "VALIDATION_ERROR");
      await denied(second.port, storage, effects, deltas, "/v1/config/billing/items%5B0%5D", "PUT", { value: "bad" }, "UNSUPPORTED_OPERATION");
    } finally {
      deltas.close();
      await second.close();
    }
  });

  test("composed root constraints and a nonwinning branch still apply after persistence", async () => {
    const { storage, effects } = provider({ billing: { kind: "text", mode: "safe" } });
    const composed = {
      type: "object",
      properties: { kind: { type: "string" }, mode: { type: "string" }, other: { type: "number" } },
      additionalProperties: false,
      allOf: [{ type: "object", properties: { mode: { type: "string", const: "safe" } }, additionalProperties: true }],
      anyOf: [
        { type: "object", properties: { kind: { type: "string", const: "text" }, mode: { type: "string" } }, additionalProperties: true },
        { type: "object", properties: { kind: { type: "string", const: "count" }, other: { type: "number" } }, additionalProperties: true },
      ],
    };
    const first = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      expect((await register(first.port, composed)).status).toBe(201);
    } finally {
      await first.close();
    }
    const second = await startWeaverServer({ port: 0, providers: [storage] });
    const deltas = await watchDeltas(second.port);
    try {
      expect((await request(second.port, "/v1/config/billing/mode")).body.data.value).toBe("safe");
      await denied(second.port, storage, effects, deltas, "/v1/config/billing/mode", "PUT", { value: "unsafe" }, "VALIDATION_ERROR");
      expect((await request(second.port, "/v1/config/billing/other", "PUT", { value: 2 })).status).toBe(200);
      expect((await storage.load()).entries.billing).toEqual({ kind: "text", mode: "safe", other: 2 });
      await denied(second.port, storage, effects, deltas, "/v1/config/billing/other", "PUT", { value: "invalid" }, "VALIDATION_ERROR");
    } finally {
      deltas.close();
      await second.close();
    }
  });

  test("an invalid persisted sibling blocks a declared partial write without modifying storage after restart", async () => {
    const { storage, effects } = provider({ billing: { mode: "old", items: 42 } });
    const first = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      expect((await register(first.port, { ...schema, additionalProperties: false })).status).toBe(201);
    } finally {
      await first.close();
    }
    const second = await startWeaverServer({ port: 0, providers: [storage] });
    const deltas = await watchDeltas(second.port);
    try {
      await denied(second.port, storage, effects, deltas, "/v1/config/billing/mode", "PUT", { value: "new" }, "VALIDATION_ERROR");
      expect((await storage.load()).entries.billing).toEqual({ mode: "old", items: 42 });
    } finally {
      deltas.close();
      await second.close();
    }
  });

  test("authenticated non-writer receives 403 before schema admission without effects", async () => {
    const { storage, effects } = provider();
    const secret = "rollout-auth-secret";
    const server = await startWeaverServer({ port: 0, providers: [storage], jwtSecret: secret });
    const admin = token(secret, "admin");
    const reader = token(secret, "reader");
    const deltas = await watchDeltas(server.port, admin);
    try {
      await denied(server.port, storage, effects, deltas, "/v1/config/billing/mode", "PUT", { value: "denied" }, "FORBIDDEN", 403, { read: admin, write: reader });
    } finally {
      deltas.close();
      await server.close();
    }
  });

  test.each([
    { name: "corrupt", entries: { _weaver: { registry: { schemas: [] } } }, message: /registry/i },
    { name: "unavailable", entries: {}, message: /unavailable/i, unavailable: true },
  ])("$name registry cannot open a public listener or mutate stored entries", async ({ entries, message, unavailable }) => {
    const { storage, effects } = provider(entries);
    const snapshot = structuredClone((await storage.load()).entries);
    if (unavailable) storage.load = async () => { throw new Error("provider unavailable"); };
    await expect(startWeaverServer({ port: 0, providers: [storage] })).rejects.toThrow(message);
    expect(counts(effects)).toEqual([0, 0, 0]);
    if (!unavailable) expect((await storage.load()).entries).toEqual(snapshot);
  });

  test("startup waits for authoritative provider load before a server becomes publicly ready", async () => {
    const { storage } = provider();
    const load = storage.load.bind(storage);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    storage.load = async () => { await gate; return load(); };
    let settled = false;
    const starting = startWeaverServer({ port: 0, providers: [storage] }).then((server) => { settled = true; return server; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const server = await starting;
    try {
      expect((await request(server.port, "/readyz")).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
