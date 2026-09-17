import { z } from "zod";
import { defineNamespace } from "../src/namespace.js";
import {
  registerNamespaces,
  zodShapeToJsonSchema,
} from "../src/registration.js";
import type { WeaverTransport } from "../src/transport.js";

describe("zodShapeToJsonSchema", () => {
  it("converts basic string/number/boolean types", () => {
    const shape = {
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    };
    const result = zodShapeToJsonSchema(shape);
    expect(result.properties).toEqual({
      name: { type: "string" },
      age: { type: "number" },
      active: { type: "boolean" },
    });
    expect(result.required).toEqual(["name", "age", "active"]);
  });

  it("handles optional fields", () => {
    const shape = {
      name: z.string(),
      nickname: z.optional(z.string()),
    };
    const result = zodShapeToJsonSchema(shape);
    expect(result.required).toEqual(["name"]);
  });

  it("handles array type", () => {
    const shape = { tags: z.array(z.string()) };
    const result = zodShapeToJsonSchema(shape);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.tags.type).toBe("array");
  });

  it("handles enum type", () => {
    const shape = { level: z.enum(["low", "medium", "high"]) };
    const result = zodShapeToJsonSchema(shape);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.level.type).toBe("string");
    expect(props.level.enum).toEqual(["low", "medium", "high"]);
  });
});

describe("registerNamespaces", () => {
  it("calls transport.registerSchema for each definition", async () => {
    const registered: string[] = [];
    const transport = {
      registerSchema: async (request: { serviceId: string }) => {
        registered.push(request.serviceId);
        return { success: true, isNewSchema: true, hasBreakingChanges: false };
      },
    } as unknown as WeaverTransport;

    const defs = [
      defineNamespace("editor", { fontSize: z.number() }),
      defineNamespace("theme", { name: z.string() }),
    ];

    const result = await registerNamespaces(defs, transport);
    expect(result.registered).toEqual(["editor", "theme"]);
    expect(result.skipped.length).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(registered).toEqual(["editor", "theme"]);
  });

  it("gracefully handles transport without registerSchema", async () => {
    const transport = {} as unknown as WeaverTransport;
    const defs = [defineNamespace("editor", { fontSize: z.number() })];

    const result = await registerNamespaces(defs, transport);
    expect(result.skipped).toEqual(["editor"]);
    expect(result.registered.length).toBe(0);
  });

  it("reports errors per-namespace without aborting", async () => {
    let callCount = 0;
    const transport = {
      registerSchema: async (request: { serviceId: string }) => {
        callCount++;
        if (request.serviceId === "bad") throw new Error("Server rejected");
        return { success: true, isNewSchema: true, hasBreakingChanges: false };
      },
    } as unknown as WeaverTransport;

    const defs = [
      defineNamespace("good", { x: z.string() }),
      defineNamespace("bad", { y: z.number() }),
      defineNamespace("also-good", { z: z.boolean() }),
    ];

    const result = await registerNamespaces(defs, transport);
    expect(result.registered).toEqual(["good", "also-good"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].namespace).toBe("bad");
    expect(callCount).toBe(3);
  });

  it("reports non-throwing failed registration responses", async () => {
    const transport = {
      registerSchema: async (request: { serviceId: string }) => {
        if (request.serviceId === "bad") {
          return {
            success: false,
            isNewSchema: false,
            hasBreakingChanges: false,
            error: {
              code: "SCHEMA_CONFLICT" as const,
              message: "Schema conflict",
            },
          };
        }
        return { success: true, isNewSchema: true, hasBreakingChanges: false };
      },
    } as unknown as WeaverTransport;

    const defs = [
      defineNamespace("good", { x: z.string() }),
      defineNamespace("bad", { y: z.number() }),
    ];

    const result = await registerNamespaces(defs, transport);
    expect(result.registered).toEqual(["good"]);
    expect(result.errors).toEqual([
      { namespace: "bad", error: "Schema conflict" },
    ]);
  });
});
