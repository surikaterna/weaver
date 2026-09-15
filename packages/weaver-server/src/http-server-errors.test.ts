import { createWeaverError } from "@weaver-conf/config-types";
import { startHttpServer } from "./http-server";

describe("HTTP boundary error mapping (weaver-s64i)", () => {
  it.each([
    createWeaverError("INTERNAL_ERROR", "PRIVATE_ERROR", { secret: "PRIVATE" }),
    createWeaverError("SERVER_DEGRADED", "PRIVATE_ERROR"),
    new Error("PRIVATE_ERROR"),
    { code: "FORBIDDEN", message: "PRIVATE_ERROR" },
  ])("sanitizes unexpected and server-side failures", async (error) => {
    const server = await startHttpServer({
      port: 0,
      handleRequest: async () => {
        throw error;
      },
    });
    try {
      const response = await fetch(`http://localhost:${server.port}/v1/events`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal server error" });
    } finally {
      await server.stop();
    }
  });
});
