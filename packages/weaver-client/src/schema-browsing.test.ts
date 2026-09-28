import { createWeaverClient } from "./client";
import { createLocalTransport } from "./local-transport";
import type { WeaverTransport } from "./transport";

function transport(): WeaverTransport {
  return createLocalTransport({
    snapshot: {
      entries: {},
      scopes: {},
      revision: "1",
      timestamp: new Date().toISOString(),
    },
  });
}

describe("registered schema browsing", () => {
  it("distinguishes unsupported from supported empty", async () => {
    const unsupported = await createWeaverClient({ transport: transport() });
    expect(await unsupported.fetchSchemas()).toBeNull();
    const supported = await createWeaverClient({
      transport: { ...transport(), fetchSchemas: async () => ({}) },
    });
    expect(await supported.fetchSchemas()).toEqual({ schemas: {} });
    await unsupported.close();
    await supported.close();
  });

  it("delegates each call without altering full schemas or environment keys", async () => {
    const schema = {
      type: "object" as const,
      required: ["ui"],
      properties: {
        ui: {
          type: "string" as const,
          "x-weaver": { visibility: "public" as const },
        },
      },
    };
    let calls = 0;
    const client = await createWeaverClient({
      transport: {
        ...transport(),
        async fetchSchemas() {
          calls++;
          return { "/app:default": schema, "/app:prod": schema };
        },
      },
    });
    expect(await client.fetchSchemas()).toEqual({
      schemas: { "/app:default": schema, "/app:prod": schema },
    });
    expect(await client.fetchSchemas()).toEqual({
      schemas: { "/app:default": schema, "/app:prod": schema },
    });
    expect(calls).toBe(2);
    await client.close();
  });

  it.each([
    new Error("401"),
    new Error("403"),
    new Error("network"),
    new Error("invalid schema"),
  ])("propagates %s without fallback", async (failure) => {
    const client = await createWeaverClient({
      transport: {
        ...transport(),
        fetchSchemas: async () => {
          throw failure;
        },
      },
    });
    await expect(client.fetchSchemas()).rejects.toBe(failure);
    await client.close();
  });
});
