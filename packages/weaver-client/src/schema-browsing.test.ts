import { ZodError } from "zod";
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
  it("requires explicit capability and does not confuse empty listing with unsupported", async () => {
    const unsupported = await createWeaverClient({ transport: transport() });
    await expect(
      unsupported.listRegisteredSchemaIdentityPage(),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      unsupported.listRegisteredSchemaIdentities(),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      unsupported.getRegisteredSchema("/app", "default"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await unsupported.close();
    let lists = 0;
    let details = 0;
    const client = await createWeaverClient({
      transport: {
        ...transport(),
        async listRegisteredSchemaIdentities() {
          lists++;
          return { anchors: [], slots: [] };
        },
        async getRegisteredSchema() {
          details++;
          throw new Error("NOT_FOUND");
        },
        async fetchSchemas() {
          throw new Error("bulk fetch must not run");
        },
      },
    });
    expect(await client.listRegisteredSchemaIdentities()).toEqual({
      anchors: [],
      slots: [],
    });
    expect(await client.listRegisteredSchemaIdentities()).toEqual({
      anchors: [],
      slots: [],
    });
    await expect(client.getRegisteredSchema("/app", "default")).rejects.toThrow(
      "NOT_FOUND",
    );
    expect({ lists, details }).toEqual({ lists: 2, details: 1 });
    await client.close();
  });

  it("validates page requests and every transport fulfillment", async () => {
    const client = await createWeaverClient({
      transport: {
        ...transport(),
        async listRegisteredSchemaIdentityPage(input) {
          if (input?.limit === 1)
            return { anchors: [], slots: [], nextCursor: null, hasMore: false };
          return { anchors: [], slots: [], nextCursor: null, hasMore: true };
        },
      },
    });
    expect(await client.listRegisteredSchemaIdentityPage({ limit: 1 })).toEqual(
      { anchors: [], slots: [], nextCursor: null, hasMore: false },
    );
    await expect(
      client.listRegisteredSchemaIdentityPage({ limit: 0 }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      client.listRegisteredSchemaIdentityPage(),
    ).rejects.toBeInstanceOf(ZodError);
    await client.close();
  });

  it("rejects malformed fulfilled identity and detail payloads on every request", async () => {
    const source = transport();
    Object.defineProperty(source, "listRegisteredSchemaIdentities", {
      value: async () => ({
        anchors: [
          {
            kind: "service",
            path: "/app",
            environment: "default",
            schema: { type: "object" },
          },
        ],
        slots: [],
      }),
    });
    Object.defineProperty(source, "getRegisteredSchema", {
      value: async () => ({
        kind: "service",
        path: "/app",
        environment: "default",
        schema: { type: "bogus" },
        metadata: {},
      }),
    });
    const client = await createWeaverClient({ transport: source });
    await expect(
      client.listRegisteredSchemaIdentities(),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      client.listRegisteredSchemaIdentities(),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      client.getRegisteredSchema("/app", "default"),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      client.getRegisteredSchema("/app", "default"),
    ).rejects.toBeInstanceOf(ZodError);
    await client.close();
  });
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

  it.each([
    undefined,
    null,
    [],
    {
      "/app:default": {
        type: "object",
        properties: { broken: { type: "bogus" } },
      },
    },
  ])("rejects malformed fulfilled schema maps without using boot state: %s", async (payload) => {
    let calls = 0;
    const source = transport();
    Object.defineProperty(source, "fetchSchemas", {
      value: async () => {
        calls++;
        return payload;
      },
    });
    const client = await createWeaverClient({ transport: source });
    await expect(client.fetchSchemas()).rejects.toBeInstanceOf(ZodError);
    await expect(client.fetchSchemas()).rejects.toBeInstanceOf(ZodError);
    expect(calls).toBe(2);
    await client.close();
  });
});
