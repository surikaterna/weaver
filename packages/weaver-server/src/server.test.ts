import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
