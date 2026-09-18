import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import type { WeaverConfigService } from "../core/config-service";
import { createWeaverConfigService } from "../core/config-service";
import { createSchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { createRestAdapter } from "./rest-adapter";

const settingsSchema = {
  type: "object" as const,
  properties: {
    db: {
      type: "object" as const,
      properties: {
        host: { type: "string" as const },
        port: { type: "integer" as const },
      },
      required: ["host", "port"],
    },
  },
  required: ["db"],
};

function mockConfigService(): WeaverConfigService {
  return {
    providers: [],
    revision: "test-rev",
    resolveAll: async () => ({
      entries: {},
      scopes: {},
      revision: "test-rev",
      timestamp: new Date().toISOString(),
    }),
    get: async () => undefined,
    getNamespace: async () => ({}),
    inspect: async () => ({
      key: "",
      effectiveValue: undefined,
      layerValues: {},
    }),
    reloadProvider: async () => {},
    set: async () => ({ success: true }),
    remove: async () => ({ success: true }),
    onDelta: () => () => {},
    batch: async <T>(fn: () => Promise<T>) => fn(),
    setMany: async () => ({ success: true, revision: "test-rev" }),
    flush: async () => {},
    refreshProviders: async () => {},
  } as unknown as WeaverConfigService;
}

describe("REST body validation", () => {
  it("PUT /v1/config/key rejects body without value field", async () => {
    const adapter = createRestAdapter({ configService: mockConfigService() });
    const res = await adapter.handleRequest("PUT", "/v1/config/app/name", {
      params: {},
      query: {},
      body: { notValue: 42 },
      headers: {},
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT /v1/config/key accepts body with value field", async () => {
    const adapter = createRestAdapter({ configService: mockConfigService() });
    const res = await adapter.handleRequest("PUT", "/v1/config/app/name", {
      params: {},
      query: {},
      body: { value: "hello" },
      headers: {},
    });
    expect(res.status).toBe(200);
  });

  it("PATCH /v1/config rejects body without entries", async () => {
    const adapter = createRestAdapter({ configService: mockConfigService() });
    const res = await adapter.handleRequest("PATCH", "/v1/config", {
      params: {},
      query: {},
      body: { notEntries: true },
      headers: {},
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /v1/config accepts body with entries object", async () => {
    const adapter = createRestAdapter({ configService: mockConfigService() });
    const res = await adapter.handleRequest("PATCH", "/v1/config", {
      params: {},
      query: {},
      body: { entries: { key1: "val1" } },
      headers: {},
    });
    expect(res.status).toBe(200);
  });

  it("POST /v1/admin/scopes/:scopeId rejects body without value", async () => {
    const sm: ScopeManager = {
      listScopes: () => [],
      listScopeValues: () => [],
      provision: async (request) => ({
        success: true,
        scopeId: request.scopeId,
        value: request.value,
      }),
      deprovision: async (request) => ({
        success: true,
        scopeId: request.scopeId,
        value: request.value,
      }),
    };
    const adapter = createRestAdapter({
      configService: mockConfigService(),
      scopeManager: sm,
    });
    const res = await adapter.handleRequest("POST", "/v1/admin/scopes/region", {
      params: {},
      query: {},
      body: { notValue: true },
      headers: {},
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/admin/scopes/:scopeId accepts valid body", async () => {
    const sm: ScopeManager = {
      listScopes: () => [],
      listScopeValues: () => [],
      provision: async (request) => ({
        success: true,
        scopeId: request.scopeId,
        value: request.value,
      }),
      deprovision: async (request) => ({
        success: true,
        scopeId: request.scopeId,
        value: request.value,
      }),
    };
    const adapter = createRestAdapter({
      configService: mockConfigService(),
      scopeManager: sm,
    });
    const res = await adapter.handleRequest("POST", "/v1/admin/scopes/region", {
      params: {},
      query: {},
      body: { value: "us-east-1" },
      headers: {},
    });
    expect(res.status).toBe(201);
  });

  it("reuses strict canonical service registration bodies", async () => {
    const configService = mockConfigService();
    const adapter = createRestAdapter({
      configService,
      schemaRegistry: createSchemaRegistry({ configService }),
    });
    const res = await adapter.handleRequest(
      "POST",
      "/v1/admin/schemas/services",
      {
        params: {},
        query: {},
        body: {
          serviceId: "checkout",
          environment: "default",
          owner: { name: "Checkout", contact: "checkout@example.com" },
          schema: settingsSchema,
          fragmentSlots: [],
          namespace: "legacy",
        },
        headers: {},
      },
    );
    expect(res.status).toBe(400);
  });

  it("delegates registered writes once and preserves nested anchor objects", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "default",
    });
    const schemaRegistry = createSchemaRegistry({ configService });
    const adapter = createRestAdapter({ configService, schemaRegistry });
    await schemaRegistry.register({
      serviceId: "checkout",
      environment: "default",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema: settingsSchema,
      fragmentSlots: [],
    });

    const write = await adapter.handleRequest(
      "PUT",
      "/v1/registered/objects/checkout",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: { db: { host: "localhost", port: 5432 } } },
        headers: {},
      },
    );
    const patch = await adapter.handleRequest(
      "PATCH",
      "/v1/registered/paths/checkout/db/host",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: "db.internal" },
        headers: {},
      },
    );

    expect(write.status).toBe(200);
    expect(patch.status).toBe(200);
    expect(await configService.get("checkout")).toEqual({
      db: { host: "db.internal", port: 5432 },
    });
  });

  it("returns a typed failure for a missing registered anchor", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {},
    });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "default",
    });
    const adapter = createRestAdapter({
      configService,
      schemaRegistry: createSchemaRegistry({ configService }),
    });

    const res = await adapter.handleRequest(
      "PUT",
      "/v1/registered/objects/missing",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: {} },
        headers: {},
      },
    );

    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(await configService.get("missing")).toBeUndefined();
  });

  it("turns malformed service responses into explicit server failures", async () => {
    const configService = mockConfigService();
    configService.setRegisteredObject = async () =>
      ({ success: "yes" }) as never;
    const adapter = createRestAdapter({
      configService,
      schemaRegistry: createSchemaRegistry({ configService }),
    });

    const res = await adapter.handleRequest(
      "PUT",
      "/v1/registered/objects/checkout",
      {
        params: {},
        query: {},
        body: { value: {} },
        headers: {},
      },
    );

    expect(res.status).toBe(500);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain(
      "Malformed registered object write response",
    );
  });

  it("leaves registered-route authorization deferred to the E slice", async () => {
    const configService = mockConfigService();
    const schemaRegistry = createSchemaRegistry({ configService });
    let gateCalls = 0;
    const adapter = createRestAdapter({
      configService,
      schemaRegistry,
      authGate: {
        toAccessContext: () => {
          gateCalls += 1;
          return { userId: "test", roles: [] };
        },
        gateRead: () => null,
        gateWrite: () => null,
        filterVisible: (_context, entries) => entries,
      },
    });

    const res = await adapter.handleRequest("GET", "/v1/admin/schemas", {
      params: {},
      query: {},
      headers: {},
    });

    expect(res.status).toBe(200);
    expect(gateCalls).toBe(0);
  });
});
