import { createWeaverError } from "@weaver-conf/config-types";
import { startHttpServer } from "./http-server";

describe("HTTP boundary error mapping (weaver-s64i)", () => {
  async function requestThrownError(error: unknown) {
    const server = await startHttpServer({
      port: 0,
      handleRequest: async () => {
        throw error;
      },
    });
    try {
      const response = await fetch(`http://localhost:${server.port}/v1/events`);
      return { response, body: await response.text() };
    } finally {
      await server.stop();
    }
  }

  it("sanitizes typed INTERNAL_ERROR responses", async () => {
    const error = createWeaverError("INTERNAL_ERROR", "PRIVATE_ERROR", {
      secret: "PRIVATE",
    });
    const { response, body } = await requestThrownError(error);

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "internal server error" },
    });
    expect(body).not.toContain("PRIVATE_ERROR");
    expect(body).not.toContain("PRIVATE");
    expect(body).not.toContain("details");
  });

  it("sanitizes typed SERVER_DEGRADED responses", async () => {
    const error = createWeaverError("SERVER_DEGRADED", "PRIVATE_ERROR", {
      secret: "PRIVATE",
    });
    const { response, body } = await requestThrownError(error);

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      error: { code: "SERVER_DEGRADED", message: "internal server error" },
    });
    expect(body).not.toContain("PRIVATE_ERROR");
    expect(body).not.toContain("PRIVATE");
    expect(body).not.toContain("details");
  });

  it("preserves approved typed client-error messages", async () => {
    const { response, body } = await requestThrownError(
      createWeaverError("FORBIDDEN", "Scope access denied"),
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(body)).toEqual({
      error: { code: "FORBIDDEN", message: "Scope access denied" },
    });
  });

  it.each([
    new Error("PRIVATE_ERROR"),
    { code: "FORBIDDEN", message: "PRIVATE_ERROR" },
  ])("sanitizes untyped and forged errors", async (error) => {
    const { response, body } = await requestThrownError(error);

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: "internal server error" });
  });
});
