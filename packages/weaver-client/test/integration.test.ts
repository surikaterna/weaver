import { z } from "zod";
import { createWeaverClient } from "../src/client.js";
import { defineNamespace } from "../src/namespace.js";
import type { WeaverTransport } from "../src/transport.js";
import type { ConfigDelta, Unsubscribe } from "../src/types.js";

function createMockTransport(
  state: Record<string, unknown> = {},
): WeaverTransport & { fireDeltas: (deltas: ConfigDelta[]) => void } {
  const subscribers: Array<(delta: ConfigDelta) => void> = [];

  return {
    async resolveAll() {
      return {
        entries: { ...state },
        scopes: {},
        revision: "rev-1",
        timestamp: new Date().toISOString(),
      };
    },
    async get(_key) {
      return undefined;
    },
    async getNamespace(_prefix) {
      return {};
    },
    async inspect(_key) {
      return {};
    },
    subscribe(handler): Unsubscribe {
      subscribers.push(handler);
      return () => {
        const idx = subscribers.indexOf(handler);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    async set(_key, _value) {
      return { success: true, revision: "rev-2" };
    },
    async setMany(_entries) {
      return { success: true, revision: "rev-2" };
    },
    async remove(_key) {
      return { success: true, revision: "rev-2" };
    },
    async listScopes() {
      return [];
    },
    async listScopeValues() {
      return [];
    },
    async close() {},
    fireDeltas(deltas: ConfigDelta[]) {
      for (const d of deltas) {
        for (const sub of subscribers) sub(d);
      }
    },
  };
}

describe("Integration: WeaverClient full flow", () => {
  it("creates client, uses typed namespace, get/set works", async () => {
    const transport = createMockTransport({
      editor: { fontSize: 14, theme: "dark" },
    });
    const client = await createWeaverClient({ transport });

    const editorNs = defineNamespace("editor", {
      fontSize: z.number(),
      theme: z.string(),
    });

    const editor = client.namespace(editorNs);
    expect(editor.get("fontSize")).toBe(14);
    expect(editor.get("theme")).toBe("dark");

    const result = await editor.set("fontSize", 16);
    expect(result.success).toBe(true);

    await client.close();
  });

  it("untyped namespace works with string prefix", async () => {
    const transport = createMockTransport({ editor: { fontSize: 14 } });
    const client = await createWeaverClient({ transport });

    const editor = client.namespace("editor");
    expect(editor.get("fontSize")).toBe(14);
    expect(editor.getAll()).toEqual({ fontSize: 14 });

    await client.close();
  });

  it("registerNamespaces delegates to transport", async () => {
    const registered: string[] = [];
    const transport = createMockTransport();
    (transport as unknown as Record<string, unknown>).registerSchema =
      async (request: { serviceId: string }) => {
        registered.push(request.serviceId);
        return { success: true, isNewSchema: true, hasBreakingChanges: false };
      };

    const client = await createWeaverClient({ transport });
    const defs = [defineNamespace("editor", { fontSize: z.number() })];
    const result = await client.registerNamespaces(defs);

    expect(result.registered).toEqual(["editor"]);
    expect(registered).toEqual(["editor"]);

    await client.close();
  });

  it("pendingRestart fires when restart-required key changes", async () => {
    const transport = createMockTransport({ app: { port: 3000 } });
    (transport as unknown as Record<string, unknown>).fetchSchemas =
      async () => ({
        "app.port": {
          type: "number",
          "x-weaver": { reloadBehavior: "restart-required" },
        },
      });

    const client = await createWeaverClient({ transport, schemas: true });
    expect(client.pendingRestart).toBe(false);

    let restartFired = false;
    client.onRestartRequired(() => {
      restartFired = true;
    });

    transport.fireDeltas([
      {
        key: "app.port",
        action: "set",
        value: 4000,
        layer: "user",
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(client.pendingRestart).toBe(true);
    expect(restartFired).toBe(true);

    await client.close();
  });
});
