import { createWeaverClient } from "./client";
import { createLocalTransport } from "./local-transport";
import type { ConfigSnapshot } from "./types";

function makeSnapshot(
  entries: Record<string, unknown> = {},
  scopes: Record<string, Record<string, unknown>> = {},
): ConfigSnapshot {
  return {
    entries,
    scopes,
    revision: "rev-1",
    timestamp: new Date().toISOString(),
  };
}

describe("WeaverClient", () => {
  it("get<T>() returns typed value from base state", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot({ app: { name: "weaver" } }),
    });
    const client = await createWeaverClient({ transport });
    const value = client.get<string>("app.name");
    expect(value).toBe("weaver");
  });

  it("get<T>(key, scopePath) returns scoped value", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot(
        { app: { name: "base" } },
        { "scope:acme": { app: { name: "acme-app" } } },
      ),
    });
    const client = await createWeaverClient({
      transport,
      scopeLoading: "eager",
    });
    const value = client.get<string>("app.name", [
      { scopeId: "scope", value: "acme" },
    ]);
    expect(value).toBe("acme-app");
  });

  it("getWithDefault() returns default when key missing", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const client = await createWeaverClient({ transport });
    const value = client.getWithDefault("missing.key", 42);
    expect(value).toBe(42);
  });

  it("getWithDefault() returns actual value when key exists", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot({ app: { port: 8080 } }),
    });
    const client = await createWeaverClient({ transport });
    const value = client.getWithDefault("app.port", 3000);
    expect(value).toBe(8080);
  });

  it("getForScope() returns scoped value", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot({}, { "env:prod": { app: { debug: false } } }),
    });
    const client = await createWeaverClient({
      transport,
      scopeLoading: "eager",
    });
    const value = client.getForScope<boolean>("app.debug", [
      { scopeId: "env", value: "prod" },
    ]);
    expect(value).toBe(false);
  });

  it("getNamespace() returns subtree", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot({
        db: { host: "localhost", port: 5432 },
        app: { name: "x" },
      }),
    });
    const client = await createWeaverClient({ transport });
    const ns = client.getNamespace("db");
    expect(ns).toEqual({ host: "localhost", port: 5432 });
  });

  it("set() delegates to transport with namespace prefix", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const client = await createWeaverClient({ transport, namespace: "myapp" });
    const result = await client.set("key", "value");
    expect(result.success).toBe(true);
  });

  it("remove() delegates to transport with namespace prefix", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot({ app: { old: true } }),
    });
    const client = await createWeaverClient({ transport });
    const result = await client.remove("app.old");
    expect(result.success).toBe(true);
  });

  it("registered path-first methods delegate without namespace prefixes", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const calls: string[] = [];
    transport.setRegisteredObject = async (anchorPath) => {
      calls.push(anchorPath);
      return { success: true };
    };
    transport.patchRegisteredPath = async (path) => {
      calls.push(path);
      return { success: true };
    };
    transport.validateRegisteredEffective = async (options) => {
      calls.push(options.anchorPath);
      return { valid: true, errors: [] };
    };
    const client = await createWeaverClient({ transport, namespace: "legacy" });
    await client.setRegisteredObject("/checkout", {});
    await client.patchRegisteredPath("/checkout/db/host", "db.internal");
    await client.validateRegisteredEffective({ anchorPath: "/checkout" });
    expect(calls).toEqual(["/checkout", "/checkout/db/host", "/checkout"]);
  });

  it("path-first registration returns canonical metadata", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    transport.registerSchema = async (request) => ({
      success: true,
      isNewSchema: true,
      hasBreakingChanges: false,
      metadata: {
        serviceId: request.serviceId,
        servicePath: `/${request.serviceId}`,
        environment: request.environment,
        providerId:
          "providerId" in request ? request.providerId : request.serviceId,
        owner: request.owner,
      },
    });
    const client = await createWeaverClient({ transport });
    const response = await client.registerSchema({
      serviceId: "checkout",
      environment: "default",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema: { type: "object" },
      fragmentSlots: [],
    });
    expect(response.metadata?.servicePath).toBe("/checkout");
  });

  it("listScopes() delegates to transport", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot({}, { "scope:acme": {} }),
    });
    const client = await createWeaverClient({ transport });
    const scopes = await client.listScopes();
    expect(Array.isArray(scopes)).toBeTruthy();
    expect(scopes.length).toBe(1);
    const scope = scopes[0];
    expect(scope).toBeTruthy();
    if (!scope) {
      throw new Error("Expected scope result");
    }
    expect(scope.id).toBe("scope");
  });

  it("listScopeValues() delegates to transport", async () => {
    const transport = createLocalTransport({
      snapshot: makeSnapshot({}, { "scope:acme": {}, "scope:beta": {} }),
    });
    const client = await createWeaverClient({ transport });
    const values = await client.listScopeValues("scope");
    expect(values.includes("acme")).toBeTruthy();
    expect(values.includes("beta")).toBeTruthy();
  });

  it("lastSyncedAt is set after initialization", async () => {
    const before = new Date();
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const client = await createWeaverClient({ transport });
    const syncedAt = client.lastSyncedAt;
    expect(syncedAt !== null).toBeTruthy();
    if (!syncedAt) {
      throw new Error("Expected syncedAt timestamp");
    }
    expect(syncedAt >= before).toBeTruthy();
  });

  it("connected is true after init, false after close", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const client = await createWeaverClient({ transport });
    expect(client.connected).toBe(true);
    await client.close();
    expect(client.connected).toBe(false);
  });

  it("pendingRestart is false by default", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const client = await createWeaverClient({ transport });
    expect(client.pendingRestart).toBe(false);
  });

  it("staleSince is null when connected, set after close", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const client = await createWeaverClient({ transport });
    expect(client.staleSince).toBe(null);
    await client.close();
    expect(client.staleSince !== null).toBeTruthy();
  });

  it("setMany() delegates to transport with namespace prefix", async () => {
    const transport = createLocalTransport({ snapshot: makeSnapshot() });
    const client = await createWeaverClient({ transport, namespace: "myapp" });
    const result = await client.setMany({
      "db.host": "localhost",
      "db.port": 5432,
    });
    expect(result.success).toBe(true);
  });

  it("setNamespace() flattens nested object and delegates to transport", async () => {
    const snapshot = makeSnapshot();
    const transport = createLocalTransport({ snapshot });
    const client = await createWeaverClient({ transport });
    const result = await client.setNamespace("db", {
      host: "localhost",
      port: 5432,
    });
    expect(result.success).toBe(true);
    const dbHost = await transport.get("db.host");
    expect(dbHost).toBe("localhost");
    const dbPort = await transport.get("db.port");
    expect(dbPort).toBe(5432);
  });

  it("setNamespace() with client namespace applies both prefixes", async () => {
    const snapshot = makeSnapshot();
    const transport = createLocalTransport({ snapshot });
    const client = await createWeaverClient({ transport, namespace: "myapp" });
    const result = await client.setNamespace("db", { host: "localhost" });
    expect(result.success).toBe(true);
    const value = await transport.get("myapp.db.host");
    expect(value).toBe("localhost");
  });
});
