import {
  registeredObjectWriteRequestSchema,
  registeredSchemasResponseSchema,
  serviceSchemaRegistrationRequestSchema,
} from "../src/contract";
import { createScompTransport, WeaverConfig } from "../src/index";

describe("transport-scomp", () => {
  it("exports the contract token with correct name", () => {
    expect(WeaverConfig.name).toBe("weaver-config-v1");
  });

  it("exports createScompTransport function", () => {
    expect(typeof createScompTransport).toBe("function");
  });

  it("exports strict path-first operation schemas", () => {
    expect(
      serviceSchemaRegistrationRequestSchema.safeParse({
        serviceId: "checkout",
        environment: "default",
        owner: { name: "Checkout", contact: "checkout@example.com" },
        schema: { type: "object" },
        fragmentSlots: [],
        namespace: "legacy",
      }).success,
    ).toBe(false);
    expect(
      registeredObjectWriteRequestSchema.safeParse({
        anchorPath: "/checkout",
        value: { db: { host: "localhost" } },
      }).success,
    ).toBe(true);
    expect(
      registeredSchemasResponseSchema.safeParse({
        schemas: { "/checkout": { type: "object" } },
      }).success,
    ).toBe(true);
  });

  it("passes canonical metadata and registered operation paths", async () => {
    const paths: string[] = [];
    const peer = {
      consumes: () => ({
        registerSchema: async (request: { serviceId: string }) => ({
          success: true,
          isNewSchema: true,
          hasBreakingChanges: false,
          metadata: {
            serviceId: request.serviceId,
            servicePath: `/${request.serviceId}`,
            environment: "default",
            providerId: request.serviceId,
            owner: { name: "Checkout", contact: "checkout@example.com" },
          },
        }),
        setRegisteredObject: async (input: { anchorPath: string }) => {
          paths.push(input.anchorPath);
          return { success: true };
        },
        patchRegisteredPath: async (input: { path: string }) => {
          paths.push(input.path);
          return { success: true };
        },
        validateRegisteredEffective: async (input: { anchorPath: string }) => {
          paths.push(input.anchorPath);
          return { valid: true, errors: [] };
        },
      }),
    };
    const transport = createScompTransport({ peer: peer as never });
    const response = await transport.registerSchema?.({
      serviceId: "checkout",
      environment: "default",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema: { type: "object" },
      fragmentSlots: [],
    });
    await transport.setRegisteredObject?.("/checkout", {});
    await transport.patchRegisteredPath?.("/checkout/db/host", "db.internal");
    await transport.validateRegisteredEffective?.({ anchorPath: "/checkout" });
    expect(response?.metadata?.servicePath).toBe("/checkout");
    expect(paths).toEqual(["/checkout", "/checkout/db/host", "/checkout"]);
  });
});
