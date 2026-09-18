import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigurationStorageProvider } from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "./providers/index";
import { startWeaverServer, startWeaverServerInternal } from "./server";

async function createBootstrapRepo(): Promise<{
  readonly repoPath: string;
  readonly rootPath: string;
}> {
  const rootPath = await mkdtemp(join(tmpdir(), "weaver-bootstrap-"));
  const repoPath = join(rootPath, "repo");
  await mkdir(join(repoPath, "bootstrap"), { recursive: true });
  await writeFile(
    join(repoPath, "bootstrap", "server.json"),
    JSON.stringify({
      layers: [{ id: "platform", provider: "git", path: "platform.json" }],
    }),
  );
  await writeFile(
    join(repoPath, "platform.json"),
    JSON.stringify({ app: { name: "Bootstrapped Weaver" } }),
  );

  const { default: simpleGit } = await import("simple-git");
  const git = simpleGit(repoPath);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "weaver@example.test");
  await git.addConfig("user.name", "Weaver Test");
  await git.add(".");
  await git.commit("seed bootstrap config");

  return { repoPath, rootPath };
}

async function removeBootstrapClone(environment: string): Promise<void> {
  await rm(join(process.cwd(), ".weaver-config", environment), {
    force: true,
    recursive: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readEnvelopeValue(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw new Error("Invalid response envelope");
  }
  const data = body.data;
  if (!isRecord(data) || !("value" in data)) {
    throw new Error("Invalid response envelope data");
  }
  return data.value;
}

function createFailingProvider(id: string): ConfigurationStorageProvider {
  return {
    id,
    layer: "platform",
    writable: true,
    load: async () => {
      throw new Error(`${id} unavailable`);
    },
    write: async () => ({ success: true }),
    remove: async () => ({ success: true }),
  };
}

function signTestJwt(secret: string, claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function rawRequest(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function startWithProviders(
  providers: ConfigurationStorageProvider[],
  onDispose: () => void,
) {
  return startWeaverServerInternal({ port: 0 }, async () => ({
    providers,
    dispose: async () => onDispose(),
  }));
}

describe("Weaver server auth gate", () => {
  it("rejects unauthenticated writes when JWT auth is enabled", async () => {
    const server = await startWeaverServer({
      port: 0,
      jwtSecret: "test-secret",
      providers: [
        createInMemoryStorageProvider({ id: "test", layer: "platform" }),
      ],
    });

    try {
      const readResponse = await fetch(
        `http://localhost:${server.port}/v1/config/test/key`,
      );
      expect(readResponse.status).toBe(200);

      const writeResponse = await fetch(
        `http://localhost:${server.port}/v1/config/test/key`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "blocked" }),
        },
      );

      expect(writeResponse.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("authorizes effective validation with the registered schema", async () => {
    const secret = "registered-schema-secret";
    const server = await startWeaverServer({
      port: 0,
      environment: "development",
      jwtSecret: secret,
      providers: [
        createInMemoryStorageProvider({ id: "test", layer: "platform" }),
      ],
    });
    const reader = signTestJwt(secret, { sub: "reader", roles: ["reader"] });
    const admin = signTestJwt(secret, { sub: "admin", roles: ["admin"] });

    try {
      const registration = await fetch(
        `http://localhost:${server.port}/v1/admin/schemas/services`,
        {
          method: "POST",
          headers: { ...bearer(admin), "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId: "checkout",
            environment: "development",
            owner: { name: "Checkout", contact: "checkout@example.com" },
            schema: {
              type: "object",
              "x-weaver": { visibility: "admin" },
              properties: { enabled: { type: "boolean" } },
              required: ["enabled"],
            },
            fragmentSlots: [],
          }),
        },
      );
      expect(registration.status).toBe(201);

      const readerEffective = await fetch(
        `http://localhost:${server.port}/v1/registered/effective/checkout`,
        { headers: bearer(reader) },
      );
      expect(readerEffective.status).toBe(403);

      const adminEffective = await fetch(
        `http://localhost:${server.port}/v1/registered/effective/checkout?env=development`,
        { headers: bearer(admin) },
      );
      expect([200, 422]).toContain(adminEffective.status);

      const readerList = await fetch(
        `http://localhost:${server.port}/v1/admin/schemas`,
        { headers: bearer(reader) },
      );
      expect(readerList.status).toBe(403);
      const adminList = await fetch(
        `http://localhost:${server.port}/v1/admin/schemas`,
        { headers: bearer(admin) },
      );
      expect(adminList.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("Weaver server error handling", () => {
  it("returns a 400 JSON response for malformed request JSON", async () => {
    const server = await startWeaverServer({ port: 0 });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/config/services.billing.currency`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{",
        },
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: "invalid request body" });
    } finally {
      await server.close();
    }
  });

  it("preserves hostile HTTP query keys for explicit route rejection", async () => {
    const server = await startWeaverServer({ port: 0 });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/admin/schemas?__proto__=value`,
      );
      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it.each([
    "env=bad&env=prod",
    "env=prod&env=prod",
    "env=&env=prod",
    "%65nv=prod&env=prod",
    "layer=platform&layer=platform",
    "scope=tenant%3Aone&scope=tenant%3Atwo",
    "inspect=&inspect=",
    "unknown=one&unknown=two",
    "__proto__=one&__proto__=two",
  ])("rejects duplicate decoded v1 query keys before auth: %s", async (query) => {
    const server = await startWeaverServer({
      port: 0,
      jwtSecret: "target-secret",
    });

    try {
      const route =
        query.startsWith("env") || query.startsWith("%65")
          ? "/v1/registered/effective/checkout"
          : "/v1/config/key";
      const response = await rawRequest(server.port, `${route}?${query}`);
      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it.each([
    "/v1/registered/effective/a%",
    "/v1/registered/effective/a%2",
    "/v1/registered/effective/a%C3%28",
    "/v1/registered/effective/a%c3%a9",
    "/v1/registered/effective/%61",
    "/v1/registered/effective/%3A",
    "/v1/registered/effective/a%2Fb",
    "/v1/registered/effective/a%2fb",
    "/v1/registered/effective/a%5Cb",
    "/v1/registered/effective/__proto__",
    "/v1/registered/effective/%5F%5Fproto%5F%5F",
    "/v1/registered/effective/constructor",
    "/v1/registered/effective/prototype",
    "/v1/registered/effective/a%00b",
    "/v1/registered/effective/a%7Fb",
    "/v1/registered/effective/a%C2%80b",
    "/v1/registered/effective/a%252Fb",
    "/v1/registered/effective/a%255Cb",
    "/v1/registered/effective/x#fragment",
    "/v1/registered/effective/x?env=development#&env=other",
  ])("rejects non-canonical request paths before auth: %s", async (path) => {
    const server = await startWeaverServer({
      port: 0,
      jwtSecret: "target-secret",
    });

    try {
      expect((await rawRequest(server.port, path)).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it.each([
    "/v1/registered/effective/check%20out",
    "/v1/registered/effective/caf%C3%A9",
    "/v1/registered/effective/what%3F",
    "/v1/registered/effective/hash%23",
    "/v1/registered/effective/100%25",
    "/v1/registered/effective/a!$&'()*+,;=:@-._~",
  ])("decodes one canonical request path before auth: %s", async (path) => {
    const server = await startWeaverServer({
      port: 0,
      jwtSecret: "target-secret",
    });

    try {
      expect((await rawRequest(server.port, path)).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("passes a decoded canonical identity to generic config routing", async () => {
    const server = await startWeaverServer({
      port: 0,
      providers: [
        createInMemoryStorageProvider({
          id: "test",
          layer: "platform",
          initialEntries: { "hello world": "decoded" },
        }),
      ],
    });

    try {
      const response = await rawRequest(
        server.port,
        "/v1/config/hello%20world?inspect=",
      );
      expect(response.status).toBe(200);
      expect(response.body).toContain("hello world");
      expect(response.body).toContain("decoded");
    } finally {
      await server.close();
    }
  });
});

describe("Weaver server CORS", () => {
  it("echoes a matching configured origin on GET requests", async () => {
    const server = await startWeaverServer({
      port: 0,
      corsOrigins: ["http://localhost:3390"],
      providers: [
        createInMemoryStorageProvider({
          id: "test",
          layer: "platform",
          initialEntries: { app: { name: "Weaver" } },
        }),
      ],
    });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/config`,
        {
          headers: {
            Origin: "http://localhost:3390",
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:3390",
      );
      expect(response.headers.get("vary")).toBe("Origin");
    } finally {
      await server.close();
    }
  });

  it("returns wildcard CORS headers for OPTIONS when '*' is configured", async () => {
    const server = await startWeaverServer({
      port: 0,
      corsOrigins: ["*"],
      providers: [
        createInMemoryStorageProvider({
          id: "test",
          layer: "platform",
          initialEntries: { app: { name: "Weaver" } },
        }),
      ],
    });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/config`,
        {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3390",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
          },
        },
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toContain(
        "OPTIONS",
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization, Content-Type",
      );
    } finally {
      await server.close();
    }
  });

  it("echoes a matching configured origin on /v1/events SSE route", async () => {
    const server = await startWeaverServer({
      port: 0,
      corsOrigins: ["http://localhost:3390"],
      providers: [
        createInMemoryStorageProvider({
          id: "test",
          layer: "platform",
          initialEntries: { app: { name: "Weaver" } },
        }),
      ],
    });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/events`,
        {
          headers: {
            Origin: "http://localhost:3390",
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:3390",
      );
      expect(response.headers.get("vary")).toBe("Origin");
      await response.body?.cancel();
    } finally {
      await server.close();
    }
  });
});

describe("Weaver server bootstrap", () => {
  it("uses bootstrap providers from a configured Git repository", async () => {
    const { repoPath, rootPath } = await createBootstrapRepo();
    const environment = `test-${Date.now()}-bootstrap`;
    const server = await startWeaverServer({
      port: 0,
      repoUrl: repoPath,
      environment,
    });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/config/app/name`,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readEnvelopeValue(body)).toBe("Bootstrapped Weaver");
    } finally {
      await server.close();
      await removeBootstrapClone(environment);
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  it("uses explicit providers instead of bootstrapping when both are supplied", async () => {
    const provider = createInMemoryStorageProvider({
      id: "explicit",
      layer: "platform",
      initialEntries: { app: { name: "Explicit Provider" } },
    });

    const server = await startWeaverServer({
      port: 0,
      repoUrl: join(tmpdir(), "missing-weaver-bootstrap-repo"),
      environment: `test-${Date.now()}-explicit`,
      providers: [provider],
    });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/config/app/name`,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readEnvelopeValue(body)).toBe("Explicit Provider");
    } finally {
      await server.close();
    }
  });

  it("keeps the in-memory fallback without repoUrl or providers", async () => {
    const server = await startWeaverServer({ port: 0 });

    try {
      const response = await fetch(
        `http://localhost:${server.port}/v1/config/app/name`,
      );

      expect(response.status).toBe(200);
      expect(server.isReady).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("cleans up when startup fails after config service creation", async () => {
    let disposeCalled = false;

    await expect(
      startWeaverServerInternal({ port: -1 }, async () => ({
        providers: [
          createInMemoryStorageProvider({
            id: "conflict",
            layer: "platform",
          }),
        ],
        dispose: async () => {
          disposeCalled = true;
        },
      })),
    ).rejects.toThrow();
    expect(disposeCalled).toBe(true);
  });

  it("routes tenant:<id> writes to matching scoped providers", async () => {
    const server = await startWeaverServer({
      port: 0,
      providers: [
        createInMemoryStorageProvider({
          id: "platform",
          layer: "platform",
          initialEntries: { app: { theme: "light" } },
        }),
        createInMemoryStorageProvider({
          id: "tenant-surikat",
          layer: "tenant:surikat",
          initialEntries: {},
        }),
      ],
    });

    try {
      const writeResponse = await fetch(
        `http://localhost:${server.port}/v1/config/app/theme?layer=tenant:surikat`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "dark" }),
        },
      );
      expect(writeResponse.status).toBe(200);

      const scopedReadResponse = await fetch(
        `http://localhost:${server.port}/v1/config/app/theme?scope=tenant:surikat`,
      );
      const scopedBody = await scopedReadResponse.json();

      expect(scopedReadResponse.status).toBe(200);
      expect(readEnvelopeValue(scopedBody)).toBe("dark");
    } finally {
      await server.close();
    }
  });

  it("supports tenant:<id> writes without predeclared tenant provider", async () => {
    const server = await startWeaverServer({
      port: 0,
      providers: [
        createInMemoryStorageProvider({
          id: "platform",
          layer: "platform",
          initialEntries: { app: { theme: "light" } },
        }),
        createInMemoryStorageProvider({
          id: "tenant-base",
          layer: "tenant",
          initialEntries: {},
        }),
      ],
    });

    try {
      const writeResponse = await fetch(
        `http://localhost:${server.port}/v1/config/app/theme?layer=tenant:surikat`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "dark" }),
        },
      );
      expect(writeResponse.status).toBe(200);

      const scopedReadResponse = await fetch(
        `http://localhost:${server.port}/v1/config/app/theme?scope=tenant:surikat`,
      );
      const scopedBody = await scopedReadResponse.json();

      expect(scopedReadResponse.status).toBe(200);
      expect(readEnvelopeValue(scopedBody)).toBe("dark");
    } finally {
      await server.close();
    }
  });
});

describe("Weaver server provider health", () => {
  it.each([
    {
      name: "mixed providers",
      providers: [
        createInMemoryStorageProvider({ id: "healthy", layer: "platform" }),
        createFailingProvider("failed"),
      ],
      status: 200,
      body: { status: "degraded", degradedProviders: ["failed"] },
    },
    {
      name: "all failed providers",
      providers: [
        createFailingProvider("first"),
        createFailingProvider("second"),
      ],
      status: 503,
      body: {
        status: "unavailable",
        degradedProviders: ["first", "second"],
      },
    },
    {
      name: "all healthy providers",
      providers: [
        createInMemoryStorageProvider({ id: "first", layer: "platform" }),
        createInMemoryStorageProvider({ id: "second", layer: "tenant" }),
      ],
      status: 200,
      body: { status: "ok" },
    },
  ])("reports $name from configured cardinality", async ({
    providers,
    status,
    body,
  }) => {
    let disposeCalls = 0;
    const server = await startWithProviders(providers, () => {
      disposeCalls += 1;
    });

    try {
      const response = await fetch(`http://localhost:${server.port}/readyz`);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject(body);
    } finally {
      await server.close();
    }
    expect(disposeCalls).toBe(1);
  });
});
