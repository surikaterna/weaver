import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { startWeaverServer } from "../src/server.ts";

const owner = { name: "Billing", contact: "billing@example.com" };
const schema = {
  type: "object",
  properties: {
    mode: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    plugins: {
      type: "object",
      properties: { tax: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false } },
      additionalProperties: false,
    },
  },
  additionalProperties: true,
};

function provider(entries = {}) {
  return createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: entries });
}

async function request(port, path, method = "GET", body) {
  const response = await fetch(`http://localhost:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function register(port, serviceSchema = schema) {
  return request(port, "/v1/admin/schemas/services", "POST", {
    serviceId: "billing", environment: "development", owner, schema: serviceSchema,
    fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
  });
}

describe("schema-required rollout across public readiness and restart", () => {
  test("known empty persistence rejects seed writes until registration; restart preserves both authority and data", async () => {
    const storage = provider();
    const first = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      expect((await request(first.port, "/readyz")).status).toBe(200);
      expect((await request(first.port, "/v1/config/billing", "PUT", { value: { mode: "early" } })).body.error.code).toBe("SCHEMA_NOT_REGISTERED");
      expect((await storage.load()).entries).toEqual({});
      expect((await register(first.port)).status).toBe(201);
      expect((await request(first.port, "/v1/config/billing", "PUT", { value: { mode: "seed", items: ["one"] } })).status).toBe(200);
    } finally {
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

  test("old unregistered and undeclared open children remain readable but cannot be changed or removed after restart", async () => {
    const storage = provider({ billing: { mode: "old", rogue: "keep", items: ["one"] }, old: { key: "keep" } });
    const first = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      expect((await register(first.port)).status).toBe(201);
    } finally {
      await first.close();
    }
    const second = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      for (const path of ["billing/rogue", "old/key"]) {
        expect((await request(second.port, `/v1/config/${path}`)).body.data.value).toBe("keep");
        for (const method of ["PUT", "DELETE"]) {
          const result = await request(second.port, `/v1/config/${path}`, method, method === "PUT" ? { value: "changed" } : undefined);
          expect(result.body.error.code).toBe("SCHEMA_NOT_REGISTERED");
        }
      }
      expect((await storage.load()).entries.billing.items).toEqual(["one"]);
      expect((await storage.load()).entries.billing.rogue).toBe("keep");
      expect((await storage.load()).entries.old.key).toBe("keep");
    } finally {
      await second.close();
    }
  });

  test("rehydrated pattern, schema-valued wildcard, fragment and array declarations constrain public writes", async () => {
    const storage = provider();
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
        schema: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false },
      });
      expect(fragment.status).toBe(201);
    } finally {
      await first.close();
    }
    const second = await startWeaverServer({ port: 0, providers: [storage] });
    try {
      const put = (path, value) => request(second.port, `/v1/config/${path}`, "PUT", { value });
      const flag = await put("billing/flag_live", true);
      expect(flag.status, JSON.stringify(flag.body)).toBe(200);
      expect((await put("billing/custom", { value: 1 })).status).toBe(200);
      expect((await put("billing/items", ["one"])).status).toBe(200);
      expect((await put("billing/plugins/tax", { enabled: true })).status).toBe(200);
      const before = structuredClone((await storage.load()).entries.billing);
      expect((await put("billing/custom", { value: 1, extra: "bad" })).body.error.code).toBe("SCHEMA_NOT_REGISTERED");
      expect((await put("billing/plugins/tax", { enabled: true, rogue: 1 })).body.error.code).toBe("SCHEMA_NOT_REGISTERED");
      expect((await put("billing/items%5B0%5D", "bad")).body.error.code).toBe("UNSUPPORTED_OPERATION");
      expect((await storage.load()).entries.billing).toEqual(before);
    } finally {
      await second.close();
    }
  });

  test.each([
    { name: "corrupt", entries: { _weaver: { registry: { schemas: [] } } }, message: /registry/i },
    { name: "unavailable", entries: {}, message: /unavailable/i, unavailable: true },
  ])("$name registry cannot open a public listener or mutate stored entries", async ({ entries, message, unavailable }) => {
    const storage = provider(entries);
    const snapshot = structuredClone((await storage.load()).entries);
    const write = vi.spyOn(storage, "write");
    if (unavailable) storage.load = async () => { throw new Error("provider unavailable"); };
    await expect(startWeaverServer({ port: 0, providers: [storage] })).rejects.toThrow(message);
    expect(write).not.toHaveBeenCalled();
    if (!unavailable) expect((await storage.load()).entries).toEqual(snapshot);
  });

  test("startup waits for authoritative provider load before a server becomes publicly ready", async () => {
    const storage = provider();
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
