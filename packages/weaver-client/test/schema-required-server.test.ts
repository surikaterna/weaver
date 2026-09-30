import { createHmac } from "node:crypto";
import { weaverErrorSchema } from "@weaver-conf/config-types";
import {
  createInMemoryStorageProvider,
  startWeaverServer,
} from "@weaver-conf/weaver-server";
import { createWeaverClient } from "../src/client.js";
import { createHttpTransport } from "../src/http-transport.js";

const owner = { name: "Billing", contact: "billing@example.com" };
const options = { layer: "platform" };

function jwt(secret: string, roles: string[]): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "reader", roles }),
  ).toString("base64url");
  const message = `${header}.${payload}`;
  return `${message}.${createHmac("sha256", secret).update(message).digest("base64url")}`;
}

describe("public client writes against the schema-bound server", () => {
  it("does not report rejection, mutate cache, or replay after a committed write loses its response", async () => {
    const provider = createInMemoryStorageProvider({
      id: "memory",
      layer: "platform",
    });
    const server = await startWeaverServer({
      port: 0,
      environment: "default",
      providers: [provider],
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const admin = createHttpTransport({ baseUrl });
    try {
      expect(
        (
          await admin.registerSchema?.({
            serviceId: "billing",
            environment: "default",
            owner,
            fragmentSlots: [],
            schema: {
              type: "object",
              properties: { mode: { type: "string" } },
            },
          })
        )?.success,
      ).toBe(true);
      const writes = vi.spyOn(provider, "write");
      let dispatched = 0;
      const transport = createHttpTransport({
        baseUrl,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === "PUT") {
            dispatched++;
            throw new Error("response lost after commit");
          }
          return response;
        },
      });
      const client = await createWeaverClient({
        transport: { ...transport, subscribe: () => () => {} },
        schemas: true,
      });
      try {
        const result = await client.set("billing.mode", "committed", options);
        expect(result).toMatchObject({
          success: false,
          error: { code: "WRITE_OUTCOME_UNKNOWN" },
        });
        expect(weaverErrorSchema.safeParse(result.error).success).toBe(true);
        expect([dispatched, writes.mock.calls.length]).toEqual([1, 1]);
        expect(client.get("billing.mode")).toBeUndefined();
        expect((await provider.load()).entries.billing).toEqual({
          mode: "committed",
        });
      } finally {
        await client.close();
      }
      const reconnected = await createWeaverClient({
        transport: createHttpTransport({ baseUrl }),
      });
      try {
        expect(reconnected.get("billing.mode")).toBe("committed");
        expect([dispatched, writes.mock.calls.length]).toEqual([1, 1]);
      } finally {
        await reconnected.close();
      }
    } finally {
      await admin.close();
      await server.close();
    }
  });
  it("preserves JWT 401/403 before cache or schema disclosure", async () => {
    const secret = "schema-write-secret";
    const provider = createInMemoryStorageProvider({
      id: "memory",
      layer: "platform",
    });
    const server = await startWeaverServer({
      port: 0,
      environment: "default",
      jwtSecret: secret,
      providers: [provider],
    });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      for (const [token, code] of [
        [undefined, "UNAUTHORIZED"],
        [jwt(secret, ["reader"]), "FORBIDDEN"],
      ] as const) {
        const transport = createHttpTransport({
          baseUrl: url,
          ...(token ? { token } : {}),
        });
        const client = await createWeaverClient({
          transport: {
            ...transport,
            fetchSchemas: async () => ({
              "/billing:default": {
                type: "object",
                properties: { mode: { type: "string" } },
              },
            }),
          },
          schemas: true,
        });
        try {
          expect(
            (await client.set("billing.mode", 42, options)).error?.code,
          ).toBe(code);
          expect(
            (await client.set("missing.key", "x", options)).error?.code,
          ).toBe(code);
        } finally {
          await client.close();
        }
      }
      expect((await provider.load()).entries.billing).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("sends once despite disconnected SSE/offline boot, without queuing or optimistic mutation", async () => {
    const provider = createInMemoryStorageProvider({
      id: "memory",
      layer: "platform",
    });
    const server = await startWeaverServer({
      port: 0,
      environment: "default",
      providers: [provider],
    });
    const http = createHttpTransport({
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      expect(
        (
          await http.registerSchema?.({
            serviceId: "billing",
            environment: "default",
            owner,
            fragmentSlots: [],
            schema: {
              type: "object",
              properties: { mode: { type: "string" } },
            },
          })
        )?.success,
      ).toBe(true);
      const writes = vi.spyOn(provider, "write");
      const persistence = {
        load: async () => ({
          entries: { billing: { mode: "cached" } },
          scopes: {},
          revision: "cached",
          timestamp: new Date().toISOString(),
        }),
        save: async () => {},
      };
      const transport = {
        ...http,
        resolveAll: async () => {
          throw new Error("offline boot");
        },
      };
      const client = await createWeaverClient({
        transport,
        persistence,
        offlineBoot: true,
        schemas: true,
      });
      try {
        expect(client.connected).toBe(false);
        expect(client.get("billing.mode")).toBe("cached");
        expect(
          (await client.set("billing.rogue", "x", options)).error?.code,
        ).toBe("SCHEMA_NOT_REGISTERED");
        expect(writes).toHaveBeenCalledTimes(0);
        expect(
          (await client.set("billing.mode", "server", options)).success,
        ).toBe(true);
        expect(writes).toHaveBeenCalledTimes(1);
        expect(client.get("billing.mode")).toBe("cached");
        expect((await provider.load()).entries.billing).toEqual({
          mode: "server",
        });
      } finally {
        await client.close();
      }
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      await http.close();
      await server.close();
    }
  });
  it.each([
    "disabled",
    "absent",
    "stale",
    "loaded",
  ])("rejects undeclared writes with %s local schema cache", async (cache) => {
    const provider = createInMemoryStorageProvider({
      id: "memory",
      layer: "platform",
    });
    const server = await startWeaverServer({
      port: 0,
      environment: "default",
      providers: [provider],
    });
    const transport = createHttpTransport({
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      const registered = await transport.registerSchema?.({
        serviceId: "billing",
        environment: "default",
        owner,
        fragmentSlots: [],
        schema: {
          type: "object",
          properties: {
            mode: { type: "string" },
            "0": { type: "string" },
            items: { type: "array", items: { type: "string" } },
            instances: {
              type: "object",
              patternProperties: {
                ".*": {
                  type: "object",
                  properties: { mode: { type: "string" } },
                },
              },
            },
          },
        },
      });
      expect(registered?.success).toBe(true);
      const clientTransport = createHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      const bootTransport =
        cache === "absent"
          ? {
              ...clientTransport,
              fetchSchemas: async () => {
                throw new Error("offline schema cache");
              },
            }
          : cache === "stale"
            ? { ...clientTransport, fetchSchemas: async () => ({}) }
            : clientTransport;
      const client = await createWeaverClient({
        transport: bootTransport,
        ...(cache === "disabled" ? {} : { schemas: true }),
      });
      try {
        const ns = client.namespace("billing");
        if (cache === "loaded") {
          expect(client.validate("billing.mode", 42).valid).toBe(false);
        }
        const denied = [
          await client.set("unregistered.mode", "x", options),
          await client.set("billing.rogue", "x", options),
          await client.setMany(
            { "billing.mode": "ok", "billing.rogue": "x" },
            options,
          ),
          await client.setNamespace(
            "billing",
            { rogue: { nested: "x" } },
            options,
          ),
          await ns.set("rogue", "x", options),
          await ns.setMany({ mode: "ok", rogue: "x" }, options),
          await client.instance("billing", "one").set("rogue", "x", options),
          await ns.instance("one").set("rogue", "x", options),
          await client.remove("billing.rogue", options),
        ];
        for (const [index, result] of denied.entries()) {
          expect(result.success, `operation ${index}`).toBe(false);
          expect(result.error?.code, `operation ${index}`).toBe(
            "SCHEMA_NOT_REGISTERED",
          );
          expect(weaverErrorSchema.safeParse(result.error).success).toBe(true);
        }
        expect((await provider.load()).entries.billing).toBeUndefined();
        expect((await provider.load()).entries.unregistered).toBeUndefined();
        expect(
          (await client.set("billing.mode", 42, options)).error?.code,
        ).toBe("VALIDATION_ERROR");
        expect(
          (await client.patchRegisteredPath("/billing/mode", 42, options)).error
            ?.code,
        ).toBe("VALIDATION_ERROR");
        expect((await client.set("billing.mode", "ok", options)).success).toBe(
          true,
        );
        expect(
          (
            await client.set(
              "billing",
              { mode: "ready", items: ["x"] },
              options,
            )
          ).success,
        ).toBe(true);
        const indexed = await client.set("billing.items.0", "x", options);
        expect(indexed).toMatchObject({
          error: { code: "UNSUPPORTED_OPERATION" },
        });
        expect(
          (await client.set("billing.items[0]", "x", options)).error?.code,
        ).toBe("UNSUPPORTED_OPERATION");
        expect(
          (await client.remove("billing.items[0]", options)).error?.code,
        ).toBe("UNSUPPORTED_OPERATION");
        expect(
          (
            await client.setMany(
              { "billing.mode": "new", "billing.items[0]": "x" },
              options,
            )
          ).error?.code,
        ).toBe("UNSUPPORTED_OPERATION");
        expect(
          (await client.set("billing.0", "object property", options)).success,
        ).toBe(true);
        expect((await provider.load()).entries.billing).toEqual({
          "0": "object property",
          mode: "ready",
          items: ["x"],
        });
      } finally {
        await client.close();
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });
});
