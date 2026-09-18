import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import type { AuthContext } from "../auth/auth-middleware";
import type { WeaverConfigService } from "../core/config-service";
import { createWeaverConfigService } from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
import { createSchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import type { AuthGate } from "./auth-gate";
import type { RestAdapter, RestRequest, RestResponse } from "./rest-adapter";
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
    setRegisteredObject: async () => ({ success: true, revision: "test-rev" }),
    patchRegisteredPath: async () => ({ success: true, revision: "test-rev" }),
    validateRegisteredEffective: async () => ({ valid: true, errors: [] }),
    flush: async () => {},
    refreshProviders: async () => {},
  } as unknown as WeaverConfigService;
}

interface RequestCase {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

interface RouteCase extends RequestCase {
  readonly name: string;
  readonly successStatus: number;
  readonly operation: "read" | "write";
  readonly gateKey: string;
  readonly gateLayer?: string;
}

const nonAdminContext: AuthContext = {
  identity: { userId: "reader", roles: ["reader"], claims: {} },
  isAdmin: false,
  isService: false,
  isUser: true,
};

const adminContext: AuthContext = {
  identity: { userId: "operator", roles: ["admin"], claims: {} },
  isAdmin: true,
  isService: false,
  isUser: true,
};

const serviceRegistrationBody = {
  serviceId: "checkout",
  environment: "default",
  owner: { name: "Checkout", contact: "checkout@example.com" },
  schema: settingsSchema,
  fragmentSlots: [],
};

const adminRouteCases: readonly RouteCase[] = [
  {
    name: "schema listing",
    method: "GET",
    path: "/v1/admin/schemas",
    successStatus: 200,
    operation: "read",
    gateKey: "_weaver.registry.schemas",
  },
  {
    name: "service registration",
    method: "POST",
    path: "/v1/admin/schemas/services",
    body: serviceRegistrationBody,
    successStatus: 201,
    operation: "write",
    gateKey: "_weaver.registry.schemas",
    gateLayer: "admin",
  },
  {
    name: "fragment registration",
    method: "POST",
    path: "/v1/admin/schemas/fragments",
    body: {
      serviceId: "checkout",
      providerId: "payments",
      slotPath: "/plugins",
      environment: "default",
      owner: { name: "Payments", contact: "payments@example.com" },
      schema: { type: "object" },
    },
    successStatus: 201,
    operation: "write",
    gateKey: "_weaver.registry.schemas",
    gateLayer: "admin",
  },
];

const registeredRouteCases: readonly RouteCase[] = [
  {
    name: "registered object write",
    method: "PUT",
    path: "/v1/registered/objects/checkout",
    query: { layer: "tenant:acme", env: "prod" },
    headers: { "if-match": '"rev-1"' },
    body: { value: { db: { host: "localhost", port: 5432 } } },
    successStatus: 200,
    operation: "write",
    gateKey: "checkout",
    gateLayer: "tenant:acme",
  },
  {
    name: "registered path patch",
    method: "PATCH",
    path: "/v1/registered/paths/checkout/db/host",
    query: { layer: "platform", env: "prod" },
    headers: { "if-match": "rev-2" },
    body: { value: "db.internal" },
    successStatus: 200,
    operation: "write",
    gateKey: "checkout.db.host",
    gateLayer: "platform",
  },
  {
    name: "registered effective validation",
    method: "GET",
    path: "/v1/registered/effective/checkout",
    query: { env: "prod", scope: "tenant:acme" },
    successStatus: 200,
    operation: "read",
    gateKey: "checkout",
  },
];

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

  it("preserves explicit unauthenticated mode when no gate is installed", async () => {
    const configService = mockConfigService();
    const adapter = createRestAdapter({
      configService,
      schemaRegistry: createSchemaRegistry({ configService }),
    });

    const res = await adapter.handleRequest("GET", "/v1/admin/schemas", {
      params: {},
      query: {},
      headers: {},
    });

    expect(res.status).toBe(200);
  });
});

describe("registered REST authorization", () => {
  it.each(
    adminRouteCases,
  )("authorizes $name after admin identity and before registry effects", async (route) => {
    const missing = createRouteHarness("allow");
    expect((await send(missing.adapter, route)).status).toBe(401);
    expect(effectCount(missing.calls)).toBe(0);
    expect(gateCount(missing.calls)).toBe(0);

    const lowRole = createRouteHarness("allow");
    expect((await send(lowRole.adapter, route, nonAdminContext)).status).toBe(
      403,
    );
    expect(effectCount(lowRole.calls)).toBe(0);
    expect(gateCount(lowRole.calls)).toBe(0);

    const denied = createRouteHarness("deny");
    expect((await send(denied.adapter, route, adminContext)).status).toBe(403);
    expect(effectCount(denied.calls)).toBe(0);
    expect(gateCount(denied.calls)).toBe(1);
    expectAdminMapping(denied.calls, route.operation);

    const allowed = createRouteHarness("allow");
    expect((await send(allowed.adapter, route, adminContext)).status).toBe(
      route.successStatus,
    );
    expect(effectCount(allowed.calls)).toBe(1);
    expect(gateCount(allowed.calls)).toBe(1);
    expectAdminMapping(allowed.calls, route.operation);
  });

  it.each(
    registeredRouteCases,
  )("maps one policy call before delegating $name", async (route) => {
    const missing = createRouteHarness("allow");
    expect((await send(missing.adapter, route)).status).toBe(401);
    expect(effectCount(missing.calls)).toBe(0);
    expect(gateCount(missing.calls)).toBe(0);

    const denied = createRouteHarness("deny");
    expect((await send(denied.adapter, route, nonAdminContext)).status).toBe(
      403,
    );
    expect(effectCount(denied.calls)).toBe(0);
    expect(gateCount(denied.calls)).toBe(1);
    expectRegisteredMapping(denied.calls, route);

    const allowed = createRouteHarness("allow");
    expect((await send(allowed.adapter, route, nonAdminContext)).status).toBe(
      route.successStatus,
    );
    expect(effectCount(allowed.calls)).toBe(1);
    expect(gateCount(allowed.calls)).toBe(1);
    expectRegisteredMapping(allowed.calls, route);
  });

  it("denies malformed registration bodies before parsing them", async () => {
    const denied = createRouteHarness("deny");
    const route = { ...routeCase(adminRouteCases, 1), body: { invalid: true } };
    const response = await send(denied.adapter, route, adminContext);

    expect(response.status).toBe(403);
    expect(denied.calls.registrations).toBe(0);
    expect(gateCount(denied.calls)).toBe(1);
  });

  it("gates valid registered metadata before parsing a malformed body", async () => {
    const denied = createRouteHarness("deny");
    const route = {
      ...routeCase(registeredRouteCases, 0),
      body: { invalid: true },
    };
    expect((await send(denied.adapter, route, nonAdminContext)).status).toBe(
      403,
    );
    expect(denied.calls.objectWrites).toHaveLength(0);
    expect(gateCount(denied.calls)).toBe(1);

    const allowed = createRouteHarness("allow");
    expect((await send(allowed.adapter, route, nonAdminContext)).status).toBe(
      400,
    );
    expect(allowed.calls.objectWrites).toHaveLength(0);
    expect(gateCount(allowed.calls)).toBe(1);
  });

  it("authorizes constant admin resources before registry availability", async () => {
    const calls = createRouteCalls();
    const configService = mockConfigService();
    const adapter = createRestAdapter({
      configService,
      authGate: createCountingGate(calls, "deny"),
    });

    const response = await send(
      adapter,
      routeCase(adminRouteCases, 1),
      adminContext,
    );
    expect(response.status).toBe(403);
    expect(gateCount(calls)).toBe(1);
    expect(effectCount(calls)).toBe(0);
  });
});

describe("registered REST canonical requests", () => {
  it("maps env and If-Match into complete write requests", async () => {
    const harness = createRouteHarness("allow");
    await send(
      harness.adapter,
      routeCase(registeredRouteCases, 0),
      nonAdminContext,
    );
    await send(
      harness.adapter,
      routeCase(registeredRouteCases, 1),
      nonAdminContext,
    );
    await send(
      harness.adapter,
      routeCase(registeredRouteCases, 2),
      nonAdminContext,
    );

    expect(harness.calls.objectWrites).toEqual([
      {
        layer: "tenant:acme",
        path: "/checkout",
        value: { db: { host: "localhost", port: 5432 } },
        environment: "prod",
        expectedRevision: "rev-1",
      },
    ]);
    expect(harness.calls.pathPatches).toEqual([
      {
        layer: "platform",
        path: "/checkout/db/host",
        value: "db.internal",
        environment: "prod",
        expectedRevision: "rev-2",
      },
    ]);
    expect(harness.calls.effectiveReads).toEqual([
      {
        path: "/checkout",
        environment: "prod",
        scopePath: [{ scopeId: "tenant", value: "acme" }],
      },
    ]);
  });

  it.each([
    ["empty layer", { layer: "" }],
    ["empty environment", { env: "" }],
    ["unknown query", { unexpected: "value" }],
    ["canonical environment alias", { environment: "prod" }],
    ["canonical revision alias", { ifRevision: "rev-1" }],
    ["conflicting environment names", { env: "prod", environment: "other" }],
    ["null environment", recordWithValue("env", null)],
    ["prototype query", ownRecord("__proto__", "value")],
    ["constructor query", ownRecord("constructor", "value")],
    ["prototype-name query", ownRecord("prototype", "value")],
  ])("rejects %s before authorization", async (_name, query) => {
    const harness = createRouteHarness("allow");
    const route = { ...routeCase(registeredRouteCases, 0), query };
    expect((await send(harness.adapter, route, nonAdminContext)).status).toBe(
      400,
    );
    expect(gateCount(harness.calls)).toBe(0);
    expect(effectCount(harness.calls)).toBe(0);
  });

  it.each([
    "",
    '""',
    '"unterminated',
  ])("rejects malformed If-Match %j before authorization", async (ifMatch) => {
    const harness = createRouteHarness("allow");
    const route = {
      ...routeCase(registeredRouteCases, 0),
      headers: { "if-match": ifMatch },
    };
    expect((await send(harness.adapter, route, nonAdminContext)).status).toBe(
      400,
    );
    expect(gateCount(harness.calls)).toBe(0);
    expect(effectCount(harness.calls)).toBe(0);
  });

  it.each([
    ["reserved path", "/v1/registered/effective/__proto__", {}],
    [
      "unknown effective query",
      "/v1/registered/effective/checkout",
      { other: "x" },
    ],
    [
      "malformed scope",
      "/v1/registered/effective/checkout",
      { scope: "tenant" },
    ],
    ["empty effective env", "/v1/registered/effective/checkout", { env: "" }],
  ])("rejects %s routing metadata before authorization", async (_name, path, query) => {
    const harness = createRouteHarness("allow");
    const route = {
      method: "GET",
      path,
      query,
      headers: {},
      successStatus: 200,
      operation: "read",
      gateKey: "checkout",
    };
    expect((await send(harness.adapter, route, nonAdminContext)).status).toBe(
      400,
    );
    expect(gateCount(harness.calls)).toBe(0);
    expect(effectCount(harness.calls)).toBe(0);
  });

  it.each([
    ["null body", null],
    ["missing value", {}],
    ["unknown body key", { value: {}, unexpected: true }],
    ["prototype body", withOwnKey({ value: {} }, "__proto__", "value")],
    ["constructor body", withOwnKey({ value: {} }, "constructor", "value")],
    ["prototype-name body", withOwnKey({ value: {} }, "prototype", "value")],
  ])("rejects %s after one authorized gate call", async (_name, body) => {
    const harness = createRouteHarness("allow");
    const route = { ...routeCase(registeredRouteCases, 0), body };
    expect((await send(harness.adapter, route, nonAdminContext)).status).toBe(
      400,
    );
    expect(gateCount(harness.calls)).toBe(1);
    expect(effectCount(harness.calls)).toBe(0);
  });

  it.each([
    "__proto__",
    "constructor",
    "prototype",
  ])("rejects registration body own key %s after admin authorization", async (key) => {
    const harness = createRouteHarness("allow");
    const route = {
      ...routeCase(adminRouteCases, 1),
      body: withOwnKey(serviceRegistrationBody, key, "value"),
    };
    expect((await send(harness.adapter, route, adminContext)).status).toBe(400);
    expect(gateCount(harness.calls)).toBe(1);
    expect(harness.calls.registrations).toBe(0);
  });

  it("accepts explicit undefined optional fields and unknown values", async () => {
    const harness = createRouteHarness("allow");
    const route = {
      ...routeCase(registeredRouteCases, 0),
      query: recordWithValue("env", undefined),
      body: recordWithValue("value", undefined),
      headers: {},
    };

    expect((await send(harness.adapter, route, nonAdminContext)).status).toBe(
      200,
    );
    expect(harness.calls.objectWrites).toEqual([
      {
        layer: "platform",
        path: "/checkout",
        value: undefined,
        environment: undefined,
        expectedRevision: undefined,
      },
    ]);
  });

  it("rejects admin query data after one successful policy call", async () => {
    const harness = createRouteHarness("allow");
    const route = { ...routeCase(adminRouteCases, 0), query: { env: "prod" } };

    expect((await send(harness.adapter, route, adminContext)).status).toBe(400);
    expect(gateCount(harness.calls)).toBe(1);
    expect(effectCount(harness.calls)).toBe(0);
  });
});

interface CapturedWrite {
  readonly layer: string;
  readonly path: string;
  readonly value: unknown;
  readonly environment?: string | undefined;
  readonly expectedRevision?: string | undefined;
}

interface CapturedEffectiveRead {
  readonly path: string;
  readonly environment?: string | undefined;
  readonly scopePath?: ReadonlyArray<{ scopeId: string; value: string }>;
}

interface RouteCalls {
  readonly gateReads: string[];
  readonly gateWrites: Array<{ layer: string; key: string }>;
  lists: number;
  registrations: number;
  readonly objectWrites: CapturedWrite[];
  readonly pathPatches: CapturedWrite[];
  readonly effectiveReads: CapturedEffectiveRead[];
}

interface RouteHarness {
  readonly adapter: RestAdapter;
  readonly calls: RouteCalls;
}

function createRouteHarness(policy: "allow" | "deny"): RouteHarness {
  const calls = createRouteCalls();
  const configService = mockConfigService();
  configService.setRegisteredObject = async (layer, path, value, context) => {
    calls.objectWrites.push({
      layer,
      path,
      value,
      environment: context.environment,
      expectedRevision: context.expectedRevision,
    });
    return { success: true, revision: "next-rev" };
  };
  configService.patchRegisteredPath = async (layer, path, value, context) => {
    calls.pathPatches.push({
      layer,
      path,
      value,
      environment: context.environment,
      expectedRevision: context.expectedRevision,
    });
    return { success: true, revision: "next-rev" };
  };
  configService.validateRegisteredEffective = async (path, context) => {
    calls.effectiveReads.push({
      path,
      ...(context.environment ? { environment: context.environment } : {}),
      ...(context.scopePath ? { scopePath: context.scopePath } : {}),
    });
    return { valid: true, errors: [] };
  };
  const adapter = createRestAdapter({
    configService,
    schemaRegistry: createCountingRegistry(calls),
    authGate: createCountingGate(calls, policy),
  });
  return { adapter, calls };
}

function createRouteCalls(): RouteCalls {
  return {
    gateReads: [],
    gateWrites: [],
    lists: 0,
    registrations: 0,
    objectWrites: [],
    pathPatches: [],
    effectiveReads: [],
  };
}

function createCountingRegistry(calls: RouteCalls): SchemaRegistry {
  return {
    register: async () => {
      calls.registrations += 1;
      return {
        success: true,
        isNewSchema: true,
        hasBreakingChanges: false,
      };
    },
    getSchema: async () => null,
    resolveAnchor: async () => null,
    listAll: () => {
      calls.lists += 1;
      return {};
    },
  };
}

function createCountingGate(
  calls: RouteCalls,
  policy: "allow" | "deny",
): AuthGate {
  const policyResponse = policy === "deny" ? forbiddenResponse() : null;
  return {
    toAccessContext: (context) => ({
      userId:
        context.identity.userId ?? context.identity.serviceId ?? "anonymous",
      roles: context.identity.roles ?? [],
    }),
    gateRead: (_context, key) => {
      calls.gateReads.push(key);
      return policyResponse;
    },
    gateWrite: (_context, layer, key) => {
      calls.gateWrites.push({ layer, key });
      return policyResponse;
    },
    filterVisible: (_context, entries) => entries,
  };
}

function forbiddenResponse(): RestResponse {
  return {
    status: 403,
    body: { error: { code: "FORBIDDEN", message: "Denied" } },
    headers: { "content-type": "application/json" },
  };
}

async function send(
  adapter: RestAdapter,
  route: RequestCase,
  authContext?: AuthContext,
): Promise<RestResponse> {
  const request: RestRequest = {
    params: {},
    query: route.query ?? {},
    body: route.body,
    headers: route.headers ?? {},
    ...(authContext ? { authContext } : {}),
  };
  return adapter.handleRequest(route.method, route.path, request);
}

function gateCount(calls: RouteCalls): number {
  return calls.gateReads.length + calls.gateWrites.length;
}

function effectCount(calls: RouteCalls): number {
  return (
    calls.lists +
    calls.registrations +
    calls.objectWrites.length +
    calls.pathPatches.length +
    calls.effectiveReads.length
  );
}

function expectAdminMapping(
  calls: RouteCalls,
  operation: "read" | "write",
): void {
  if (operation === "read") {
    expect(calls.gateReads).toEqual(["_weaver.registry.schemas"]);
    return;
  }
  expect(calls.gateWrites).toEqual([
    { layer: "admin", key: "_weaver.registry.schemas" },
  ]);
}

function expectRegisteredMapping(calls: RouteCalls, route: RouteCase): void {
  if (route.operation === "read") {
    expect(calls.gateReads).toEqual([route.gateKey]);
    return;
  }
  expect(calls.gateWrites).toEqual([
    { layer: route.gateLayer, key: route.gateKey },
  ]);
}

function ownRecord(key: string, value: string): Record<string, string> {
  return Object.fromEntries([[key, value]]);
}

function recordWithValue(key: string, value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  Reflect.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return record;
}

function withOwnKey(
  source: object,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return Object.fromEntries([...Object.entries(source), [key, value]]);
}

function routeCase(cases: readonly RouteCase[], index: number): RouteCase {
  const route = cases[index];
  if (!route) throw new Error(`Missing route case at index ${String(index)}`);
  return route;
}
