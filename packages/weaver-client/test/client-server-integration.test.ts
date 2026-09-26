import {
  createInMemoryStorageProvider,
  startWeaverServer,
} from "@weaver-conf/weaver-server";
import type { WeaverClient } from "../src/client.js";
import { createWeaverClient } from "../src/client.js";
import { createHttpTransport } from "../src/http-transport.js";
import type { LocalTransport } from "../src/local-transport.js";
import { createLocalTransport } from "../src/local-transport.js";
import type { ConfigDelta } from "../src/types.js";

const owner = { name: "Checkout", contact: "checkout@example.com" };

describe("client schema flow against a real D1 server", () => {
  it("uses canonical environment keys and the longest registered anchor", async () => {
    const server = await startWeaverServer({
      port: 0,
      environment: "default",
      providers: [
        createInMemoryStorageProvider({
          id: "memory",
          layer: "platform",
          initialEntries: {
            checkout: {
              enabled: true,
              plugins: { analytics: { enabled: true, token: "secret" } },
            },
          },
        }),
      ],
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const registration = createHttpTransport({ baseUrl });
      await registerSchemas(registration);
      await expect(registration.fetchSchemas?.()).resolves.toMatchObject({
        "/checkout:default": { type: "object" },
        "/checkout:production": { type: "object" },
        "/checkout/plugins/analytics:default": { type: "object" },
      });
      await registration.close();

      let remoteWrites = 0;
      const trackedFetch: typeof fetch = async (input, init) => {
        if (["PUT", "PATCH", "DELETE"].includes(init?.method ?? "GET")) {
          remoteWrites++;
        }
        return fetch(input, init);
      };
      const first = await createWeaverClient({
        transport: createHttpTransport({ baseUrl, fetch: trackedFetch }),
        schemas: true,
      });
      expect(first.validate("checkout.enabled", "wrong").valid).toBe(false);
      expect(first.isSensitive("checkout.plugins.analytics.token")).toBe(true);
      const rejected = await first.set("checkout.enabled", "wrong");
      expect(rejected).toMatchObject({
        success: false,
        error: { code: "VALIDATION_ERROR" },
      });
      expect(remoteWrites).toBe(0);
      const batch = await first.setMany({
        "checkout.enabled": "wrong",
        "checkout.plugins.analytics.enabled": true,
      });
      expect(batch).toMatchObject({
        success: false,
        error: { code: "VALIDATION_ERROR" },
      });
      expect(remoteWrites).toBe(0);
      await first.close();

      const rebooted = await createWeaverClient({
        transport: createHttpTransport({ baseUrl }),
        schemas: true,
      });
      expect(
        rebooted.validate("checkout.plugins.analytics.enabled", true).valid,
      ).toBe(true);
      expect(
        rebooted.validate("checkout.plugins.analytics.enabled", "service-shape")
          .valid,
      ).toBe(false);
      await rebooted.close();

      const production = await createWeaverClient({
        transport: createHttpTransport({ baseUrl }),
        schemas: { environment: "production" },
      });
      expect(production.validate("checkout.enabled", "production").valid).toBe(
        true,
      );
      expect(production.validate("checkout.enabled", true).valid).toBe(false);
      expect(production.isSensitive("checkout.plugins.analytics.token")).toBe(
        false,
      );
      await production.close();
    } finally {
      await server.close();
    }
  });
});

async function registerSchemas(
  transport: ReturnType<typeof createHttpTransport>,
): Promise<void> {
  const baseSchema = {
    type: "object" as const,
    properties: {
      enabled: { type: "boolean" as const },
      plugins: {
        type: "object" as const,
        additionalProperties: {
          type: "object" as const,
          properties: { enabled: { type: "string" as const } },
        },
      },
    },
  };
  await transport.registerSchema?.({
    serviceId: "checkout",
    environment: "default",
    owner,
    schema: baseSchema,
    fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
  });
  await transport.registerSchema?.({
    serviceId: "checkout",
    environment: "production",
    owner,
    schema: {
      type: "object",
      properties: { enabled: { type: "string" } },
    },
    fragmentSlots: [],
  });
  await transport.registerSchema?.({
    serviceId: "checkout",
    providerId: "analytics",
    slotPath: "/plugins",
    environment: "default",
    owner,
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        token: { type: "string", "x-weaver": { sensitive: true } },
      },
    },
  });
}

describe("client↔server integration (local transport round-trip)", () => {
  let transport: LocalTransport;
  let client: WeaverClient;

  beforeEach(async () => {
    transport = createLocalTransport({
      snapshot: {
        entries: {
          app: { name: "initial" },
          database: { host: "localhost", port: 5432 },
        },
        scopes: {},
        revision: "rev-0",
        timestamp: new Date().toISOString(),
      },
    });
    client = await createWeaverClient({ transport });
  });

  afterEach(async () => {
    await client.close();
  });

  it("should set and get a value round-trip", async () => {
    const result = await client.set("app.name", "Weaver");
    expect(result.success).toBe(true);
    expect(client.get<string>("app.name")).toBe("Weaver");
  });

  it("should get namespace values", () => {
    expect(client.getNamespace("database")).toEqual({
      host: "localhost",
      port: 5432,
    });
  });

  it("should reflect writes after delta notification", async () => {
    await client.set("cache.redis.host", "redis.local");
    transport.pushDelta({
      key: "cache.redis.host",
      action: "set",
      value: "redis.local",
      layer: "user",
      timestamp: new Date().toISOString(),
    });
    expect(client.get<string>("cache.redis.host")).toBe("redis.local");
  });

  it("should receive change deltas via subscription", () => {
    const received: ConfigDelta[] = [];
    client.onChange("app.*", (deltas) => received.push(...deltas));
    const delta: ConfigDelta = {
      key: "app.name",
      action: "set",
      value: "Updated",
      layer: "user",
      timestamp: new Date().toISOString(),
    };
    transport.pushDelta(delta);
    expect(received).toEqual([delta]);
  });

  it("should remove a value", async () => {
    expect((await client.remove("app.name")).success).toBe(true);
    expect(client.get("app.name")).toBe(undefined);
  });

  it("should report connected mode after boot", () => {
    expect(client.mode).toBe("live");
    expect(client.connected).toBe(true);
  });

  it("should transition to disconnected on close", async () => {
    await client.close();
    expect(client.connected).toBe(false);
    client = await createWeaverClient({
      transport: createLocalTransport({
        snapshot: {
          entries: {},
          scopes: {},
          revision: "r",
          timestamp: new Date().toISOString(),
        },
      }),
    });
  });

  it("should set many values and confirm write success", async () => {
    const result = await client.setMany({
      "feature.a": true,
      "feature.b": false,
    });
    expect(result.success).toBe(true);
    expect(result.revision).toBeTruthy();
  });
});
