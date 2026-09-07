import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import type { WeaverConfigService } from "../core/config-service";
import { createWeaverConfigService } from "../core/config-service";
import { createSchemaRegistry } from "../core/schema-registry";
import type { ConfigDelta } from "../types/index";
import type { SSEAdapter } from "./sse-adapter";
import { createSSEAdapter } from "./sse-adapter";

function createMockConfigService(initialEntries?: Record<string, unknown>) {
  const deltaHandlers: Array<(delta: ConfigDelta) => void> = [];
  let currentRevision = "rev-1";
  const entries = initialEntries ?? {
    "app.name": "test",
    "app.port": 3000,
    "db.host": "localhost",
  };

  return {
    configService: {
      get revision() {
        return currentRevision;
      },
      providers: [],
      resolveAll: async (_options?: { scopePath?: unknown }) => ({
        entries: { ...entries },
        scopes: {},
        revision: currentRevision,
      }),
      onDelta: (handler: (delta: ConfigDelta) => void) => {
        deltaHandlers.push(handler);
        return () => {
          const idx = deltaHandlers.indexOf(handler);
          if (idx >= 0) deltaHandlers.splice(idx, 1);
        };
      },
      get: async () => undefined,
      getNamespace: async () => ({}),
      inspect: async () => ({ key: "", layers: [], resolved: undefined }),
      reloadProvider: async () => {},
      set: async () => ({ ok: true as const }),
      remove: async () => ({ ok: true as const }),
    } as unknown as WeaverConfigService,
    emitDelta(delta: ConfigDelta) {
      for (const h of [...deltaHandlers]) h(delta);
    },
    setRevision(rev: string) {
      currentRevision = rev;
    },
  };
}

function makeDelta(overrides?: Partial<ConfigDelta>): ConfigDelta {
  return {
    action: "set",
    key: "app.name",
    value: "updated",
    layer: "platform",
    environment: "production",
    timestamp: "2026-05-03T12:00:00Z",
    ...overrides,
  };
}

interface ParsedMessage {
  event: string;
  data: Record<string, unknown>;
}

function parseMessages(client: {
  messages: readonly string[];
}): ParsedMessage[] {
  return client.messages.map((raw) => {
    const eventMatch = raw.match(/^event: (.+)$/m);
    const dataMatch = raw.match(/^data: (.+)$/m);
    if (!eventMatch || !dataMatch) {
      throw new Error("Malformed SSE message");
    }
    const event = eventMatch[1];
    const data = dataMatch[1];
    if (!event || !data) {
      throw new Error("Malformed SSE event payload");
    }
    return {
      event,
      data: JSON.parse(data) as Record<string, unknown>,
    };
  });
}

function msg(msgs: ParsedMessage[], idx: number): ParsedMessage {
  const m = msgs[idx];
  if (!m) {
    throw new Error(`expected message at index ${idx}`);
  }
  return m;
}

function expectRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBe(null);
  return value as Record<string, unknown>;
}

describe("SSEAdapter", () => {
  let mock: ReturnType<typeof createMockConfigService>;
  let adapter: SSEAdapter;

  beforeEach(() => {
    mock = createMockConfigService();
    adapter = createSSEAdapter({ configService: mock.configService });
  });

  it("sends snapshot event on client creation", async () => {
    const client = await adapter.createClient();
    const msgs = parseMessages(client);
    expect(msgs.length).toBe(1);
    expect(msg(msgs, 0).event).toBe("snapshot");
    expect(msg(msgs, 0).data.entries).toEqual({
      "app.name": "test",
      "app.port": 3000,
      "db.host": "localhost",
    });
    expect(msg(msgs, 0).data.revision).toBe("rev-1");
    client.close();
  });

  it("does not expose protected metadata in snapshots", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {
        app: {
          name: "public",
          direct: { _weaver: "mount", source: "_weaver.registry.schemas" },
          bridge: { _weaver: "mount", source: "_weaver.registry.schemas" },
          chained: { _weaver: "mount", source: "app.bridge" },
        },
        _weaver: { registry: { schemas: "LEAK" } },
      },
    });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const realAdapter = createSSEAdapter({ configService });

    const client = await realAdapter.createClient({ prefix: "app" });
    const messages = parseMessages(client);

    expect(msg(messages, 0).data.entries).toEqual({ app: { name: "public" } });
    expect(JSON.stringify(messages)).not.toContain("LEAK");
    client.close();
  });

  it("filters snapshot entries by prefix", async () => {
    const client = await adapter.createClient({ prefix: "app" });
    const msgs = parseMessages(client);
    expect(msg(msgs, 0).event).toBe("snapshot");
    const entries = expectRecord(msg(msgs, 0).data.entries);
    expect(Object.keys(entries).sort()).toEqual(["app.name", "app.port"]);
    expect(entries["db.host"]).toBe(undefined);
    client.close();
  });

  it("receives change events for matching deltas", async () => {
    const client = await adapter.createClient();
    mock.setRevision("rev-2");
    mock.emitDelta(makeDelta({ key: "app.name", value: "newval" }));
    await Promise.resolve();
    const msgs = parseMessages(client);
    expect(msgs.length).toBe(2); // snapshot + change
    expect(msg(msgs, 1).event).toBe("change");
    expect(msg(msgs, 1).data.key).toBe("app.name");
    expect(msg(msgs, 1).data.value).toBe("newval");
    expect(msg(msgs, 1).data.revision).toBe("rev-2");
    client.close();
  });

  it("filters change events by prefix", async () => {
    const client = await adapter.createClient({ prefix: "db" });
    mock.emitDelta(makeDelta({ key: "app.name" }));
    mock.emitDelta(makeDelta({ key: "db.host", value: "newhost" }));
    await Promise.resolve();
    const msgs = parseMessages(client);
    // snapshot + 1 matching change (app.name filtered out)
    expect(msgs.length).toBe(2);
    expect(msg(msgs, 1).event).toBe("change");
    expect(msg(msgs, 1).data.key).toBe("db.host");
    client.close();
  });

  it("rejects invalid snapshots and suppresses invalid subscription deltas", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: { checkout: { mode: "prod" } },
    });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "test",
    });
    const registry = createSchemaRegistry({ configService });
    await registry.register({
      serviceId: "checkout",
      environment: "test",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: { type: "string", enum: ["prod", "test"] },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      fragmentSlots: [],
    });
    const realAdapter = createSSEAdapter({ configService });
    const client = await realAdapter.createClient();

    const partial = await configService.setRegisteredObject(
      "platform",
      "/checkout",
      { limit: 10 },
      { schemaRegistry: registry },
    );
    expect(partial.success).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(parseMessages(client)).toHaveLength(1);
    await expect(realAdapter.createClient()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(realAdapter.clientCount).toBe(1);
    client.close();
  });

  it("sends checkpoint events to all clients on timer", async (_t) => {
    const client1 = await adapter.createClient();
    const client2 = await adapter.createClient({ prefix: "db" });
    mock.setRevision("rev-5");

    // Use a very short interval for testing
    adapter.startCheckpointTimer(10);
    await new Promise((r) => setTimeout(r, 50));
    adapter.stopCheckpointTimer();

    const msgs1 = parseMessages(client1);
    const msgs2 = parseMessages(client2);

    const checkpoints1 = msgs1.filter((m) => m.event === "checkpoint");
    const checkpoints2 = msgs2.filter((m) => m.event === "checkpoint");

    expect(checkpoints1.length >= 1).toBeTruthy();
    expect(checkpoints2.length >= 1).toBeTruthy();
    expect(msg(checkpoints1, 0).data.revision).toBe("rev-5");

    client1.close();
    client2.close();
  });

  it("removes client and stops receiving events", async () => {
    const client = await adapter.createClient();
    expect(adapter.clientCount).toBe(1);
    adapter.removeClient(client);
    expect(adapter.clientCount).toBe(0);

    mock.emitDelta(makeDelta());
    const msgs = parseMessages(client);
    // Only the initial snapshot, no change events after removal
    expect(msgs.length).toBe(1);
  });

  it("closeAll disconnects all clients", async () => {
    const client1 = await adapter.createClient();
    const client2 = await adapter.createClient();
    expect(adapter.clientCount).toBe(2);
    adapter.closeAll();
    expect(adapter.clientCount).toBe(0);

    mock.emitDelta(makeDelta());
    expect(parseMessages(client1).length).toBe(1); // only snapshot
    expect(parseMessages(client2).length).toBe(1); // only snapshot
  });

  it("multiple clients with different filters receive correct events", async () => {
    const appClient = await adapter.createClient({ prefix: "app" });
    const dbClient = await adapter.createClient({ prefix: "db" });

    mock.emitDelta(makeDelta({ key: "app.name", value: "v2" }));
    mock.emitDelta(makeDelta({ key: "db.host", value: "newdb" }));
    await Promise.resolve();

    const appMsgs = parseMessages(appClient);
    const dbMsgs = parseMessages(dbClient);

    // appClient: snapshot + app.name change
    expect(appMsgs.length).toBe(2);
    expect(msg(appMsgs, 1).data.key).toBe("app.name");

    // dbClient: snapshot + db.host change
    expect(dbMsgs.length).toBe(2);
    expect(msg(dbMsgs, 1).data.key).toBe("db.host");

    appClient.close();
    dbClient.close();
  });

  it("client with since parameter still gets snapshot (v1)", async () => {
    const client = await adapter.createClient({ since: "rev-42" });
    const msgs = parseMessages(client);
    expect(msgs.length).toBe(1);
    expect(msg(msgs, 0).event).toBe("snapshot");
    client.close();
  });

  it("caps message buffer at maxBufferSize, evicting oldest", async () => {
    const smallAdapter = createSSEAdapter({
      configService: mock.configService,
      maxBufferSize: 5,
    });
    const client = await smallAdapter.createClient();
    // snapshot is message 1; send 6 more changes to exceed buffer of 5
    for (let i = 0; i < 6; i++) {
      mock.emitDelta(makeDelta({ key: "app.name", value: `v${i}` }));
    }
    await Promise.resolve();
    // Buffer should be capped at 5
    expect(client.messages.length).toBe(5);
    // Oldest messages (snapshot + early changes) should be evicted
    const msgs = parseMessages(client);
    // Last message should be the most recent change
    const last = msgs.at(-1);
    expect(last).toBeTruthy();
    if (!last) {
      throw new Error("Expected last SSE message");
    }
    expect(last.data.value).toBe("v5");
    client.close();
  });
});
