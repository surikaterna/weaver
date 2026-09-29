import { weaverErrorSchema } from "@weaver-conf/config-types";
import {
  createInMemoryStorageProvider,
  startWeaverServer,
} from "@weaver-conf/weaver-server";
import { createWeaverClient } from "../src/client.js";
import { createHttpTransport } from "../src/http-transport.js";

const owner = { name: "Billing", contact: "billing@example.com" };
const options = { layer: "platform" };

describe("public client writes against the schema-bound server", () => {
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
          expect(
            [
              "SCHEMA_NOT_REGISTERED",
              ...(cache === "loaded" ? ["VALIDATION_ERROR"] : []),
            ],
            `operation ${index}`,
          ).toContain(result.error?.code);
          if (result.error?.code === "SCHEMA_NOT_REGISTERED") {
            expect(weaverErrorSchema.safeParse(result.error).success).toBe(
              true,
            );
          }
        }
        expect((await provider.load()).entries.billing).toBeUndefined();
        expect((await provider.load()).entries.unregistered).toBeUndefined();
        expect(
          (await client.set("billing.mode", 42, options)).error?.code,
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
        expect((await provider.load()).entries.billing).toEqual({
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
