// Full-stack integration smoke test for Weaver
// Boots weaver-server, connects weaver-client via HTTP transport, and exercises major surfaces.

import { createStaticJsonStorageProvider } from "@weaver-conf/storage-provider-static-json";
import type { ConfigDelta } from "@weaver-conf/weaver-client";
import {
  createHttpTransport,
  createWeaverClient,
  defineNamespace,
} from "@weaver-conf/weaver-client";
import {
  createInMemoryStorageProvider,
  startWeaverServer,
} from "@weaver-conf/weaver-server";
import { z } from "zod";

// ─── Test Harness ────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Seed Data ───────────────────────────────────────────────

const SEED_CONFIG: Record<string, unknown> = {
  app: {
    name: "Weaver Playground",
    description: "Integration smoke test",
  },
  feature: {
    darkMode: true,
    analytics: false,
  },
  limits: {
    maxRetries: 3,
    timeout: 5000,
  },
};

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log("Weaver Playground — Integration Smoke Test\n");

  // ─── 1. Server Boot & Health Check ─────────────────────────
  section("1. Server Boot & Health Check");

  const server = await startWeaverServer({
    port: 0,
    providers: [
      createStaticJsonStorageProvider({
        id: "base",
        layer: "platform",
        data: SEED_CONFIG,
      }),
      createInMemoryStorageProvider({
        id: "default",
        layer: "default",
      }),
    ],
  });

  assert(server.port > 0, `Server started on port ${server.port}`);
  assert(server.isReady === true, "Server reports isReady=true");

  const healthRes = await fetch(`http://localhost:${server.port}/healthz`);
  assert(healthRes.status === 200, "GET /healthz returns 200");

  // ─── 2. Client Connection & Read ──────────────────────────
  section("2. Client Connection & Read");

  const transport = createHttpTransport({
    baseUrl: `http://localhost:${server.port}`,
  });

  const client = await createWeaverClient({ transport });
  assert(client.connected === true, "Client is connected after creation");

  const appName = client.get<string>("app.name");
  assert(
    appName === "Weaver Playground",
    `client.get("app.name") = "${appName}"`,
  );

  const darkMode = client.get<boolean>("feature.darkMode");
  assert(darkMode === true, `client.get("feature.darkMode") = ${darkMode}`);

  // ─── 3. Write & Read-Back ──────────────────────────────────
  section("3. Write & Read-Back");

  const writeResult = await client.set("app.version", "1.0.0", {
    layer: "default",
  });
  assert(writeResult.success === true, "client.set() returns success=true");

  // Small delay for SSE delta propagation
  await delay(150);

  const version = client.get<string>("app.version");
  assert(version === "1.0.0", `client.get("app.version") = "${version}"`);

  // ─── 4. Namespace Operations ───────────────────────────────
  section("4. Namespace Operations");

  const appNs = client.getNamespace("app");
  assert(
    typeof appNs === "object" && appNs !== null,
    "getNamespace returns an object",
  );
  assert("name" in appNs, 'Namespace has "name" key');
  assert("description" in appNs, 'Namespace has "description" key');

  // ─── 5. Typed Namespace ────────────────────────────────────
  section("5. Typed Namespace");

  const appDef = defineNamespace("app", {
    name: z.string(),
    description: z.string(),
  });

  const typedNs = client.namespace(appDef);
  const nsName = typedNs.get("name");
  assert(nsName === "Weaver Playground", `typedNs.get("name") = "${nsName}"`);

  // ─── 6. Subscriptions (onChange) ───────────────────────────
  section("6. Subscriptions (onChange)");

  const received: ConfigDelta[] = [];
  const unsub = client.onChange("app.*", (deltas) => {
    received.push(...deltas);
  });

  await client.set("app.locale", "en-US", { layer: "default" });
  await delay(200);

  assert(
    received.length > 0,
    `onChange handler called (received ${received.length} delta(s))`,
  );
  if (received.length > 0) {
    const delta = received[0];
    if (delta === undefined) {
      throw new Error("Expected at least one delta");
    }
    assert(delta.key === "app.locale", `Delta key = "${delta.key}"`);
    assert(delta.value === "en-US", `Delta value = "${delta.value}"`);
  }
  unsub();

  // ─── 7. Schema Registration ────────────────────────────────
  section("7. Schema Registration");

  const regResult = await client.registerSchema({
    serviceId: "metrics",
    environment: "default",
    owner: { name: "metrics", contact: "metrics@example.com" },
    schema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
    },
    fragmentSlots: [],
  });
  assert(regResult.success, "path-first service schema registered");

  // ─── 8. Server Auth (optional gate) ───────────────────────
  section("8. Server Auth (optional gate)");

  const authServer = await startWeaverServer({
    port: 0,
    jwtSecret: "test-secret",
    providers: [
      createInMemoryStorageProvider({ id: "auth-mem", layer: "platform" }),
    ],
  });

  assert(authServer.authEnabled === true, "Auth server has auth enabled");

  // Attempt a write without a token — should fail
  const unauthRes = await fetch(
    `http://localhost:${authServer.port}/v1/config/test/key`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "should-fail" }),
    },
  );

  assert(authServer.isReady === true, "Auth server is operational");
  assert(
    unauthRes.status === 401 || unauthRes.status === 403,
    `Unauthenticated write rejected with status ${unauthRes.status}`,
  );

  await authServer.close();

  // ─── 9. Cleanup ────────────────────────────────────────────
  section("9. Cleanup");

  await client.close();
  await server.close();

  assert(true, "Client and server closed cleanly");

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n${"═".repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Playground crashed:", err);
  process.exit(1);
});
