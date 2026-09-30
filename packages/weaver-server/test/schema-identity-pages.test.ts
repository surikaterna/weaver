import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.js";
import {
  createPersistentSchemaRegistry,
  createSchemaRegistry,
} from "../src/core/schema-registry.js";

async function freshService() {
  const provider = createInMemoryStorageProvider({
    id: "platform",
    layer: "platform",
    initialEntries: {},
  });
  return createWeaverConfigService({
    providers: [provider],
    environment: "prod",
  });
}

function service(serviceId: string, environment = "prod") {
  return {
    serviceId,
    environment,
    owner: { name: "Test", contact: "test@example.org" },
    schema: { type: "object" as const },
    fragmentSlots: [{ slotPath: "/plugins:beta", accepts: "object" as const }],
  };
}

describe("schema identity pages", () => {
  it("iterates ordinal pages in environment/path/kind code-unit order", async () => {
    const registry = createSchemaRegistry({
      configService: await freshService(),
    });
    for (const [id, env] of [
      ["svc", "z:env"],
      ["app", "A:env"],
      ["other", "a:env"],
    ])
      await registry.register(service(id, env));
    const seen: Array<{ kind: string; path: string; environment: string }> = [];
    let cursor: string | null = null;
    do {
      const page = registry.listRegisteredSchemaIdentityPage({
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.anchors, ...page.slots);
      cursor = page.nextCursor;
    } while (cursor);
    expect(
      seen.map(({ environment, path, kind }) => [environment, path, kind]),
    ).toEqual([
      ["A:env", "/app", "service"],
      ["A:env", "/app/plugins:beta", "slot"],
      ["a:env", "/other", "service"],
      ["a:env", "/other/plugins:beta", "slot"],
      ["z:env", "/svc", "service"],
      ["z:env", "/svc/plugins:beta", "slot"],
    ]);
  });
  it("orders mixed identities by code unit, never exposes bodies, and invalidates only committed local changes", async () => {
    const registry = createSchemaRegistry({
      configService: await freshService(),
    });
    expect(registry.listRegisteredSchemaIdentityPage()).toEqual({
      anchors: [],
      slots: [],
      nextCursor: null,
      hasMore: false,
    });
    for (let i = 0; i < 51; i++)
      expect(
        (
          await registry.register(
            service(
              `svc${String(i).padStart(3, "0")}`,
              i % 2 ? "dev:x" : "prod",
            ),
          )
        ).success,
      ).toBe(true);
    const first = registry.listRegisteredSchemaIdentityPage();
    expect(first.anchors.length + first.slots.length).toBe(50);
    expect(first.nextCursor).toHaveLength(55);
    const all = [...first.anchors, ...first.slots];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = registry.listRegisteredSchemaIdentityPage({ cursor });
      expect(page.anchors.length + page.slots.length).toBeLessThanOrEqual(50);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      all.push(...page.anchors, ...page.slots);
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(102);
    expect(
      new Set(
        all.map(({ kind, path, environment }) =>
          JSON.stringify([kind, path, environment]),
        ),
      ).size,
    ).toBe(102);
    expect(JSON.stringify(all)).not.toMatch(/owner|schema|metadata/);
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({ limit: 201 }),
    ).toThrow();
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({
        limit: 2,
        cursor: first.nextCursor ?? "",
      }),
    ).toThrow();
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({
        cursor: `${first.nextCursor?.slice(0, -1)}!`,
      }),
    ).toThrow();
    expect((await registry.register(service("svc000", "prod"))).success).toBe(
      true,
    );
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({
        cursor: first.nextCursor ?? "",
      }),
    ).toThrow();
    expect(registry.listRegisteredSchemaIdentities().anchors).toHaveLength(51);
    expect(Object.keys(registry.listAll())).toHaveLength(51);
  });

  it("respects raised operator max and exact boundary", async () => {
    const registry = createSchemaRegistry({
      configService: await freshService(),
      schemaIdentityMaxPageSize: 250,
    });
    for (let i = 0; i < 110; i++) await registry.register(service(`svc${i}`));
    const page = registry.listRegisteredSchemaIdentityPage({ limit: 250 });
    expect(page.anchors.length + page.slots.length).toBe(220);
    expect(page.hasMore).toBe(false);
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({ limit: 251 }),
    ).toThrow();
  });

  it("rejects malformed, noncanonical, unsafe and impossible ordinal cursors", async () => {
    const registry = createSchemaRegistry({
      configService: await freshService(),
    });
    await registry.register(service("svc"));
    const cursor =
      registry.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor ?? "";
    const mutated = (offset: number, value: bigint) => {
      const bytes = Buffer.from(cursor, "base64url");
      bytes.writeBigUInt64BE(value, offset);
      return bytes.toString("base64url");
    };
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({ cursor: `${cursor}a` }),
    ).toThrow();
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({ cursor: mutated(33, 100n) }),
    ).toThrow();
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({
        cursor: mutated(25, BigInt(Number.MAX_SAFE_INTEGER) + 1n),
      }),
    ).toThrow();
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({ cursor: mutated(25, 0n) }),
    ).toThrow();
    const unknown = Buffer.from(cursor, "base64url");
    unknown[0] = 2;
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({
        cursor: unknown.toString("base64url"),
      }),
    ).toThrow();
    unknown[0] = 1;
    unknown[1] = unknown[1] === 0 ? 1 : 0;
    expect(() =>
      registry.listRegisteredSchemaIdentityPage({
        cursor: unknown.toString("base64url"),
      }),
    ).toThrow();
  });

  it("rejects restart cursors after hydration while retaining colon-rich slots", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const config = await createWeaverConfigService({
      providers: [provider],
      environment: "prod",
    });
    const first = await createPersistentSchemaRegistry({
      configService: config,
    });
    await first.register(service("svc", "prod:dev"));
    await first.register(service("other", "prod"));
    const cursor =
      first.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor ?? "";
    const restartedService = await createWeaverConfigService({
      providers: [provider],
      environment: "prod",
    });
    const restarted = await createPersistentSchemaRegistry({
      configService: restartedService,
    });
    expect(
      restarted.listRegisteredSchemaIdentityPage({ limit: 10 }).slots,
    ).toContainEqual({
      kind: "slot",
      path: "/svc/plugins:beta",
      environment: "prod:dev",
      accepts: "object",
    });
    expect(() =>
      restarted.listRegisteredSchemaIdentityPage({ cursor }),
    ).toThrow();
    await restartedService.flush();
    await config.flush();
  });

  it("serializes concurrent persistent registrations without losing either index entry", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const config = await createWeaverConfigService({
      providers: [provider],
      environment: "prod",
    });
    const registry = await createPersistentSchemaRegistry({
      configService: config,
    });
    const results = await Promise.all([
      registry.register(service("first")),
      registry.register(service("second")),
    ]);
    expect(results.every(({ success }) => success)).toBe(true);
    expect(registry.listRegisteredSchemaIdentityPage().anchors).toHaveLength(2);
    const restartedService = await createWeaverConfigService({
      providers: [provider],
      environment: "prod",
    });
    const restarted = await createPersistentSchemaRegistry({
      configService: restartedService,
    });
    expect(restarted.listRegisteredSchemaIdentityPage().anchors).toHaveLength(
      2,
    );
    await restartedService.flush();
    await config.flush();
  });
});
