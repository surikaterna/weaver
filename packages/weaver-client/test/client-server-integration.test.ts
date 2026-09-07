import { WeaverErrorInstance } from "@weaver-conf/config-types";
import type { WeaverClient } from "../src/client.js";
import { createWeaverClient } from "../src/client.js";
import type { LocalTransport } from "../src/local-transport.js";
import { createLocalTransport } from "../src/local-transport.js";
import type { ConfigDelta } from "../src/types.js";

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

    const value = client.get<string>("app.name");
    expect(value).toBe("Weaver");
  });

  it("should get namespace values", () => {
    const ns = client.getNamespace("database");
    expect(ns).toEqual({ host: "localhost", port: 5432 });
  });

  it("should reflect writes after delta notification", async () => {
    await client.set("cache.redis.host", "redis.local");

    // Simulate server pushing the delta back (as would happen in real server)
    transport.pushDelta({
      key: "cache.redis.host",
      action: "set",
      value: "redis.local",
      layer: "user",
      timestamp: new Date().toISOString(),
    });

    const value = client.get<string>("cache.redis.host");
    expect(value).toBe("redis.local");
  });

  it("should receive change deltas via subscription", () => {
    const received: ConfigDelta[] = [];
    client.onChange("app.*", (deltas) => {
      received.push(...deltas);
    });

    const delta: ConfigDelta = {
      key: "app.name",
      action: "set",
      value: "Updated",
      layer: "user",
      timestamp: new Date().toISOString(),
    };
    transport.pushDelta(delta);

    expect(received.length).toBe(1);
    expect(received[0].key).toBe("app.name");
    expect(received[0].value).toBe("Updated");
  });

  it("should remove a value", async () => {
    const result = await client.remove("app.name");
    expect(result.success).toBe(true);

    const value = client.get("app.name");
    expect(value).toBe(undefined);
  });

  it("should report connected mode after boot", () => {
    expect(client.mode).toBe("live");
    expect(client.connected).toBe(true);
  });

  it("fails client boot when the server rejects an invalid effective snapshot", async () => {
    await client.close();
    const invalidTransport = createLocalTransport({
      snapshot: {
        entries: {},
        scopes: {},
        revision: "invalid",
        timestamp: new Date().toISOString(),
      },
    });
    vi.spyOn(invalidTransport, "resolveAll").mockRejectedValue(
      new WeaverErrorInstance(
        "VALIDATION_ERROR",
        "Effective configuration does not match registered schema",
        {
          kind: "effective-configuration-invalid",
          anchorPath: "/checkout",
        },
      ),
    );

    await expect(
      createWeaverClient({ transport: invalidTransport }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { anchorPath: "/checkout" },
    });
    client = await createWeaverClient({ transport });
  });

  it("converges scoped registered roots after invalidation and recovery", async () => {
    await client.close();
    const scopePath = [{ scopeId: "tenant", value: "acme" }];
    transport = createLocalTransport({
      snapshot: {
        entries: { checkout: { mode: "base" } },
        scopes: { "tenant:acme": { checkout: { mode: "scoped" } } },
        revision: "scoped-0",
        timestamp: new Date().toISOString(),
      },
    });
    client = await createWeaverClient({ transport, scopeLoading: "hot" });

    transport.pushDelta({
      key: "checkout",
      action: "remove",
      value: null,
      layer: "tenant:acme",
      timestamp: new Date().toISOString(),
    });
    expect(client.getForScope("checkout", scopePath)).toBe(undefined);
    expect(client.get("checkout.mode")).toBe("base");

    transport.pushDelta({
      key: "checkout",
      action: "set",
      value: {
        mode: "recovered",
        plugins: { tax: { rate: 0.2 } },
        credentials: ["resolved-secret", { token: "nested-secret" }],
      },
      layer: "tenant:acme",
      timestamp: new Date().toISOString(),
    });
    expect(client.getForScope("checkout", scopePath)).toEqual({
      mode: "recovered",
      plugins: { tax: { rate: 0.2 } },
      credentials: ["resolved-secret", { token: "nested-secret" }],
    });
  });

  it.each([
    "eager",
    "hot",
    "lazy",
  ] as const)("applies canonical multi-scope effective deltas in %s mode", async (scopeLoading) => {
    await client.close();
    const scopePath = [
      { scopeId: "tenant", value: "acme" },
      { scopeId: "region", value: "eu" },
    ];
    transport = createLocalTransport({
      snapshot: {
        entries: { app: { mode: "base", limit: 1, inherited: true } },
        scopes: {
          "tenant:acme/region:eu": {
            app: { mode: "scoped", limit: 2, inherited: true },
          },
        },
        revision: "multi-0",
        timestamp: new Date().toISOString(),
      },
    });
    client = await createWeaverClient({ transport, scopeLoading });
    if (scopeLoading === "lazy") await client.preloadScope(scopePath);

    for (const layer of ["weaver-effective", "tenant:acme/region:eu"]) {
      transport.pushDelta({
        key: "app.inherited",
        action: "set",
        value: false,
        layer,
        timestamp: new Date().toISOString(),
      });
    }
    transport.pushDelta({
      key: "app[limit]",
      action: "set",
      value: 3,
      layer: "tenant:acme/region:eu",
      timestamp: new Date().toISOString(),
    });
    transport.pushDelta({
      key: "app.mode",
      action: "remove",
      value: null,
      layer: "tenant:acme/region:eu",
      timestamp: new Date().toISOString(),
    });

    expect(client.getForScope("app", scopePath)).toEqual({
      limit: 3,
      inherited: false,
    });
    expect(client.get("app")).toEqual({
      mode: "base",
      limit: 1,
      inherited: false,
    });
  });

  it("should transition to disconnected on close", async () => {
    await client.close();
    expect(client.connected).toBe(false);
    // Re-assign so afterEach doesn't double-close
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

  it("propagates schema rejections for every client write operation", async () => {
    const rejected = {
      success: false,
      error: {
        code: "VALIDATION_ERROR" as const,
        message: "registered schema",
      },
    };
    const set = vi.spyOn(transport, "set").mockResolvedValue(rejected);
    const setMany = vi.spyOn(transport, "setMany").mockResolvedValue(rejected);
    const remove = vi.spyOn(transport, "remove").mockResolvedValue(rejected);

    const results = await Promise.all([
      client.set("checkout.mode", "invalid", { environment: "other" }),
      client.setMany(
        { "checkout.mode": "invalid", "checkout[mode]": "prod" },
        { environment: "other" },
      ),
      client.remove("checkout.mode", { environment: "other" }),
    ]);

    expect(results.every((result) => !result.success)).toBe(true);
    expect(set).toHaveBeenCalledOnce();
    expect(setMany).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith("checkout.mode", "invalid", {
      environment: "other",
    });
    expect(client.get("checkout.mode")).toBe(undefined);
  });
});
