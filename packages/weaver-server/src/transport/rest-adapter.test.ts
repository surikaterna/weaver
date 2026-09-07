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
  it("normal config routes cannot bypass a bound registered schema", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: { checkout: { db: { host: "db", port: 5432 } } },
    });
    const write = vi.spyOn(provider, "write");
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "default",
    });
    const schemaRegistry = createSchemaRegistry({ configService });
    await schemaRegistry.register({
      serviceId: "checkout",
      environment: "default",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema: settingsSchema,
      fragmentSlots: [],
    });
    const adapter = createRestAdapter({ configService, schemaRegistry });

    const response = await adapter.handleRequest(
      "PUT",
      "/v1/config/checkout/db/port",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: "invalid" },
        headers: {},
      },
    );

    expect(response.status).toBe(400);
    expect(write).not.toHaveBeenCalled();
    expect(await configService.get("checkout.db.port")).toBe(5432);
  });

  it("does not expose protected metadata through REST reads", async () => {
    const provider = createInMemoryStorageProvider({
      id: "platform",
      layer: "platform",
      initialEntries: {
        app: {
          name: "public",
          direct: { _weaver: "mount", source: "_weaver.registry.schemas" },
          bridge: { _weaver: "mount", source: "_weaver.registry.schemas" },
          chained: { _weaver: "mount", source: "app.bridge" },
        },
        _weaver: { registry: { schemas: "LEAK" } },
      },
    });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "default",
    });
    const adapter = createRestAdapter({ configService });

    const snapshot = await adapter.handleRequest("GET", "/v1/config", {
      params: {},
      query: {},
      headers: {},
    });
    const direct = await adapter.handleRequest(
      "GET",
      "/v1/config/_weaver/registry/schemas",
      { params: {}, query: {}, headers: {} },
    );
    const mounted = await adapter.handleRequest(
      "GET",
      "/v1/config/app/direct",
      { params: {}, query: {}, headers: {} },
    );
    const chained = await adapter.handleRequest(
      "GET",
      "/v1/config/app/chained",
      { params: {}, query: {}, headers: {} },
    );
    const inspection = await adapter.handleRequest(
      "GET",
      "/v1/config/_weaver?inspect",
      { params: {}, query: { inspect: "" }, headers: {} },
    );

    expect(snapshot.body).toMatchObject({
      data: { entries: { app: { name: "public" } } },
    });
    expect(snapshot.body).not.toHaveProperty("data.entries._weaver");
    expect(direct.body).toMatchObject({ data: { value: undefined } });
    expect(mounted.body).toMatchObject({ data: { value: undefined } });
    expect(chained.body).toMatchObject({ data: { value: undefined } });
    expect(inspection.body).toMatchObject({
      data: { effectiveValue: undefined, layerValues: {} },
    });
    expect(JSON.stringify({ snapshot, mounted, chained })).not.toContain(
      "LEAK",
    );
  });

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

  it("rejects legacy schema registration fields", async () => {
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
          namespace: "checkout",
          ownerId: "legacy-owner",
          path: "/custom/path",
        },
        headers: {},
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns canonical registration metadata", async () => {
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
          fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
        },
        headers: {},
      },
    );
    expect(res.status).toBe(201);
    const body = res.body as {
      data: { metadata: { servicePath: string; providerId: string } };
    };
    expect(body.data.metadata.servicePath).toBe("/checkout");
    expect(body.data.metadata.providerId).toBe("checkout");
  });

  it("preserves registered patch writes as nested anchor objects", async () => {
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
    expect(write.status).toBe(200);

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
    expect(patch.status).toBe(200);
    expect(await configService.get("checkout")).toEqual({
      db: { host: "db.internal", port: 5432 },
    });
  });

  it("preserves protected _weaver write rejection for registered writes", async () => {
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
      "/v1/registered/objects/_weaver/registry/schemas",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: {} },
        headers: {},
      },
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain("reserved");
  });

  it("returns validation errors for registered patches and effective validation", async () => {
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

    const patch = await adapter.handleRequest(
      "PATCH",
      "/v1/registered/paths/checkout/db/port",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: "not-a-port" },
        headers: {},
      },
    );
    expect(patch.status).toBe(400);
    await configService.set(
      "platform",
      "checkout",
      {},
      { environment: "default" },
    );

    const effective = await adapter.handleRequest(
      "GET",
      "/v1/registered/effective/checkout",
      { params: {}, query: {}, headers: {} },
    );
    expect(effective.status).toBe(422);
    const body = effective.body as {
      data: { errors: Array<{ code: string }> };
    };
    expect(
      body.data.errors.some((error) => error.code === "missing-required"),
    ).toBe(true);
  });
});
