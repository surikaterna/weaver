import { createHmac } from "node:crypto";
import { createInMemoryStorageProvider } from "./providers/index";
import { startWeaverServer } from "./server";

const jwtSecret = "schema-admin-test-secret";

describe("Weaver server schema registry authorization", () => {
  it("enforces authentication and admin role through the HTTP auth path", async () => {
    const server = await startWeaverServer({
      port: 0,
      jwtSecret,
      providers: [
        createInMemoryStorageProvider({ id: "test", layer: "platform" }),
      ],
    });

    try {
      const url = `http://localhost:${server.port}/v1/admin/schemas`;
      const unauthenticated = await fetch(url);
      const nonAdmin = await fetch(url, {
        headers: { Authorization: `Bearer ${createToken(["reader"])}` },
      });
      const admin = await fetch(url, {
        headers: { Authorization: `Bearer ${createToken(["admin"])}` },
      });

      expect(unauthenticated.status).toBe(401);
      expect(nonAdmin.status).toBe(403);
      expect(admin.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

function createToken(roles: readonly string[]): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ sub: "schema-reader", roles });
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", jwtSecret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
