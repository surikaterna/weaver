import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { vi } from "vitest";
import { createTestService } from "../../test/setup-service";
import { createWeaverConfigService } from "../core/config-service";
import { createSchemaRegistry } from "../core/schema-registry";
import { scopeContextId } from "../core/scope-inventory";
import { createScopeManager } from "../core/scope-manager";
import { parseScopeQuery } from "../core/scope-utils";
import type { ConfigDelta } from "../types/index";
import { createRestAdapter } from "./rest-adapter";
import { createSSEAdapter } from "./sse-adapter";

const invalidScopes = [
  "",
  "tenant",
  "tenant:",
  ":acme",
  "tenant:acme/",
  "tenant:acme,",
  "tenant:acme//region:eu",
  "tenant:acme,,region:eu",
  "tenant:acme/region:",
  "tenant:acme:extra",
  "tenant:acme/region:eu:extra",
  "tenant: acme",
  "/tenant:acme",
];
const paths = [
  "/v1/config",
  "/v1/config/app/safe",
  "/v1/registered/effective/app",
];

async function setup(withUnprovisionedData = false) {
  const base = createInMemoryStorageProvider({
    id: "base",
    layer: "platform",
    initialEntries: { app: { safe: "BASE" } },
  });
  const tenant = createInMemoryStorageProvider({
    id: "tenant",
    layer: "tenant",
  });
  await tenant.loadLayer?.("tenant:acme");
  if (withUnprovisionedData) {
    expect(
      await tenant.writeLayer?.("tenant:unknown", "app.safe", "NOT_MEMBERSHIP"),
    ).toMatchObject({ success: true });
  }
  const paths = ["acme", ...(withUnprovisionedData ? ["unknown"] : [])].map(
    (value) => [{ scopeId: "tenant", value }],
  );
  const configService = await createTestService(
    {
      environment: "dev",
      providers: [base, tenant],
      scopeInventory: {
        version: 1,
        revision: "0",
        contexts: Object.fromEntries(
          paths.map((scopePath) => [
            scopeContextId(scopePath),
            { scopePath, state: "retired" },
          ]),
        ),
      },
    },
    {
      app: {
        type: "object",
        properties: { safe: { type: "string" } },
        additionalProperties: false,
      },
    },
    paths,
  );
  const schemaRegistry = createSchemaRegistry({ configService });
  const scopeManager = createScopeManager({ configService, schemaRegistry });
  const rest = createRestAdapter({
    configService,
    schemaRegistry,
    scopeManager,
  });
  const sse = createSSEAdapter({ configService });
  return { configService, scopeManager, rest, sse, tenant, base };
}

describe("transport scope boundaries (weaver-becr)", () => {
  it.each(
    invalidScopes,
  )("rejects %j before I/O or subscription", async (scope) => {
    const { configService, rest, sse, tenant } = await setup();
    const load = vi.spyOn(tenant, "loadLayer");
    const resolve = vi.spyOn(configService, "resolveAll");
    const get = vi.spyOn(configService, "get");
    const validate = vi.spyOn(configService, "validateRegisteredEffective");
    const subscribe = vi.spyOn(configService, "onDelta");
    for (const path of paths) {
      const response = await rest.handleRequest("GET", path, {
        params: {},
        headers: {},
        query: { scope },
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    }
    await expect(sse.createClient({ scope })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    for (const spy of [load, resolve, get, validate, subscribe]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(sse.clientCount).toBe(0);
  });

  it("distinguishes absent scope and preserves slash/comma full scope order", () => {
    expect(parseScopeQuery(undefined)).toBeUndefined();
    const scopes = [
      { scopeId: "tenant", value: "acme" },
      { scopeId: "region", value: "eu" },
    ];
    expect(parseScopeQuery("tenant:acme/region:eu")).toEqual(scopes);
    expect(parseScopeQuery("tenant:acme,region:eu")).toEqual(scopes);
  });

  it("rejects unknown scopes without warming, even with unprovisioned data", async () => {
    const { configService, rest, sse } = await setup(true);
    const resolve = vi.spyOn(configService, "resolveAll");
    const subscribe = vi.spyOn(configService, "onDelta");
    for (const path of paths) {
      const response = await rest.handleRequest("GET", path, {
        params: {},
        headers: {},
        query: { scope: "tenant:unknown" },
      });
      expect(response.status).toBe(404);
    }
    await expect(
      sse.createClient({ scope: "tenant:unknown" }),
    ).rejects.toMatchObject({ code: "SCOPE_NOT_FOUND" });
    expect(resolve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(sse.clientCount).toBe(0);
  });

  it("preserves dynamically provisioned inherited scopes and restart membership", async () => {
    const { configService, scopeManager, sse } = await setup();
    const result = await scopeManager.provision({
      scopeId: "tenant",
      value: "acme",
      actor: "admin",
    });
    expect(result.success).toBe(true);
    const client = await sse.createClient({ scope: "tenant:acme" });
    expect(client.messages[0]).toContain('"safe":"BASE"');
    expect(client.messages[0]).not.toContain("_weaver");
    client.close();
    await scopeManager.deprovision({
      scopeId: "tenant",
      value: "acme",
      actor: "admin",
    });
    await expect(
      sse.createClient({ scope: "tenant:acme" }),
    ).rejects.toMatchObject({ code: "SCOPE_NOT_FOUND" });
    expect((await configService.resolveAll()).entries).toEqual({
      app: { safe: "BASE" },
    });
    expect(
      await scopeManager.provision({
        scopeId: "tenant",
        value: "acme",
        actor: "admin",
      }),
    ).toMatchObject({ success: true });
    await configService.close?.();
    const restarted = await createWeaverConfigService({
      environment: "dev",
      providers: [...configService.providers],
      controlLayer: "control",
    });
    const restartedSse = createSSEAdapter({ configService: restarted });
    const afterRestart = await restartedSse.createClient({
      scope: "tenant:acme",
    });
    expect(afterRestart.messages[0]).toContain('"safe":"BASE"');
    afterRestart.close();
    await restarted.close?.();
  });

  it("uses canonical full identity for snapshot and live deltas, not children", async () => {
    const providers = ["platform", "tenant:acme", "region:eu"].map((layer) =>
      createInMemoryStorageProvider({
        id: layer.replaceAll(":", "-"),
        layer,
        initialEntries: { app: { safe: layer } },
      }),
    );
    const service = await createTestService(
      {
        environment: "dev",
        providers,
      },
      {
        app: {
          type: "object",
          properties: { safe: { type: "string" } },
          additionalProperties: false,
        },
      },
      [
        [{ scopeId: "tenant", value: "acme" }],
        [
          { scopeId: "tenant", value: "acme" },
          { scopeId: "region", value: "eu" },
        ],
      ],
    );
    const handlers = new Set<(delta: ConfigDelta) => void>();
    const adapter = createSSEAdapter({
      configService: {
        ...service,
        onDelta: (handler) => {
          handlers.add(handler);
          return () => {
            handlers.delete(handler);
          };
        },
      },
    });
    const client = await adapter.createClient({
      scope: "tenant:acme,region:eu",
    });
    expect(client.messages[0]).toContain('"safe":"region:eu"');
    for (const layer of [
      "tenant:other/region:eu",
      "tenant:acme/region:eu/extra:child",
      "tenant:acme/region:eu",
    ]) {
      for (const handler of handlers)
        handler({
          action: "set",
          key: "app.safe",
          value: layer,
          layer,
          environment: "dev",
          timestamp: new Date().toISOString(),
        });
    }
    expect(client.messages).toHaveLength(2);
    expect(client.messages[1]).toContain('"layer":"tenant:acme/region:eu"');
    client.close();
    expect(handlers.size).toBe(0);
  });

  it("rejects a missing scoped snapshot without fallback and cleans subscription", async () => {
    const provider = createInMemoryStorageProvider({
      id: "tenant",
      layer: "tenant:acme",
    });
    const service = await createTestService(
      {
        environment: "dev",
        providers: [provider],
      },
      {},
      [[{ scopeId: "tenant", value: "acme" }]],
    );
    const unsubscribe = vi.fn();
    const adapter = createSSEAdapter({
      configService: {
        ...service,
        resolveAll: async () => ({
          entries: { secret: "BASE" },
          scopes: {},
          revision: "test",
          timestamp: new Date().toISOString(),
        }),
        onDelta: () => unsubscribe,
      },
    });
    await expect(
      adapter.createClient({ scope: "tenant:acme" }),
    ).rejects.toMatchObject({ code: "SCOPE_NOT_FOUND" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(adapter.clientCount).toBe(0);
  });
});
