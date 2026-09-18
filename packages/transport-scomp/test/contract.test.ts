import {
  createScompTransport,
  registeredObjectWriteRequestSchema,
  registeredSchemasResponseSchema,
  serviceSchemaRegistrationRequestSchema,
  WeaverConfig,
} from "../src/index";

describe("transport-scomp", () => {
  it("exports the contract token with correct name", () => {
    expect(WeaverConfig.name).toBe("weaver-config-v1");
  });

  it("exports createScompTransport function", () => {
    expect(typeof createScompTransport).toBe("function");
  });

  it("exports strict registered operation schemas", () => {
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

  it("validates requests before one call and accepts typed failures", async () => {
    const requests: unknown[] = [];
    const peer = {
      consumes: () => ({
        setRegisteredObject: async (request: unknown) => {
          requests.push(request);
          return {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "invalid value" },
          };
        },
      }),
    };
    const transport = createScompTransport({ peer: peer as never });

    await expect(
      transport.setRegisteredObject?.("checkout", {}),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);

    const response = await transport.setRegisteredObject?.("/checkout", {});
    expect(response).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "invalid value" },
    });
    expect(requests).toEqual([{ anchorPath: "/checkout", value: {} }]);
  });

  it("rejects malformed registered responses instead of passing them through", async () => {
    const peer = {
      consumes: () => ({
        patchRegisteredPath: async () => ({ success: "yes" }),
      }),
    };
    const transport = createScompTransport({ peer: peer as never });

    await expect(
      transport.patchRegisteredPath?.("/checkout/db/host", "db.internal"),
    ).rejects.toThrow();
  });
});
