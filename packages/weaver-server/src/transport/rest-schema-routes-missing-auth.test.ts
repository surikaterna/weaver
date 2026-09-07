import type {
  ObjectConfigurationPropertySchema,
  WriteResult,
} from "@weaver-conf/config-types";
import type { AuthContext } from "../auth/auth-middleware";
import type { WeaverConfigService } from "../core/config-service";
import type {
  SchemaRegistrationContext,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
  SchemaRegistry,
} from "../core/schema-registry";
import type { AuthGate } from "./auth-gate";
import { createRestAdapter } from "./rest-adapter";

const settingsSchema: ObjectConfigurationPropertySchema = {
  type: "object",
  properties: {
    db: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "integer" },
      },
      required: ["host", "port"],
    },
  },
  required: ["db"],
};

interface ServiceCallCounts {
  registeredObjectWrites: number;
  registeredPathPatches: number;
  effectiveValidations: number;
}

interface RegistryCallCounts {
  registrations: number;
  lists: number;
}

interface AuthGateCallCounts {
  contextConversions: number;
  readChecks: number;
  writeChecks: number;
}

interface RouteCase {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH";
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

const routeCases: readonly RouteCase[] = [
  { name: "schema listing", method: "GET", path: "/v1/admin/schemas" },
  {
    name: "registered effective validation",
    method: "GET",
    path: "/v1/registered/effective/checkout",
  },
  {
    name: "service schema registration",
    method: "POST",
    path: "/v1/admin/schemas/services",
    body: serviceRegistrationBody(),
  },
  {
    name: "fragment schema registration",
    method: "POST",
    path: "/v1/admin/schemas/fragments",
    body: fragmentRegistrationBody(),
  },
  {
    name: "registered object write",
    method: "PUT",
    path: "/v1/registered/objects/checkout",
    query: { layer: "platform" },
    body: { value: { db: { host: "localhost", port: 5432 } } },
  },
  {
    name: "registered path patch",
    method: "PATCH",
    path: "/v1/registered/paths/checkout/db/host",
    query: { layer: "platform" },
    body: { value: "db.internal" },
  },
];

describe("REST schema routes missing authContext", () => {
  it.each(
    routeCases,
  )("returns 401 before side effects for $name when authGate is configured", async (route) => {
    const serviceCalls = createServiceCallCounts();
    const registryCalls = createRegistryCallCounts();
    const authGateCalls = createAuthGateCallCounts();
    const adapter = createRestAdapter({
      configService: createMockConfigService(serviceCalls),
      schemaRegistry: createMockSchemaRegistry(registryCalls),
      authGate: createTrackingAuthGate(authGateCalls),
    });

    const res = await adapter.handleRequest(route.method, route.path, {
      params: {},
      query: route.query ?? {},
      headers: {},
      ...(route.body === undefined ? {} : { body: route.body }),
    });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expectNoServiceCalls(serviceCalls);
    expectNoRegistryCalls(registryCalls);
    expectNoAuthGateCalls(authGateCalls);
  });
});

function createMockConfigService(
  calls: ServiceCallCounts,
): WeaverConfigService {
  return {
    providers: [],
    degradedProviders: [],
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
      effectiveLayer: undefined,
      layerValues: {},
    }),
    reloadProvider: async () => {},
    set: async () => writeSuccess(),
    remove: async () => writeSuccess(),
    onDelta: () => () => {},
    batch: async <T>(fn: () => Promise<T>) => fn(),
    setMany: async () => writeSuccess(),
    setRegisteredObject: async () => {
      calls.registeredObjectWrites += 1;
      return writeSuccess();
    },
    patchRegisteredPath: async () => {
      calls.registeredPathPatches += 1;
      return writeSuccess();
    },
    validateRegisteredEffective: async () => {
      calls.effectiveValidations += 1;
      return { valid: true, errors: [] };
    },
    flush: async () => {},
    refreshProviders: async () => {},
  };
}

function createMockSchemaRegistry(calls: RegistryCallCounts): SchemaRegistry {
  return {
    register: async (request, context) => {
      calls.registrations += 1;
      return registrationSuccess(request, context);
    },
    getSchema: async () => null,
    resolveAnchor: async () => null,
    listAll: () => {
      calls.lists += 1;
      return {};
    },
  };
}

function createTrackingAuthGate(calls: AuthGateCallCounts): AuthGate {
  return {
    toAccessContext: (_authCtx: AuthContext) => {
      calls.contextConversions += 1;
      return { userId: "auditor", roles: [] };
    },
    gateRead: () => {
      calls.readChecks += 1;
      return null;
    },
    gateWrite: () => {
      calls.writeChecks += 1;
      return null;
    },
    filterVisible: () => ({}),
  };
}

function writeSuccess(): WriteResult {
  return { success: true, revision: "test-rev" };
}

function registrationSuccess(
  request: SchemaRegistrationRequest,
  context: SchemaRegistrationContext | undefined,
): SchemaRegistrationResult {
  return {
    success: true,
    isNewSchema: true,
    hasBreakingChanges: false,
    metadata: {
      serviceId: request.serviceId,
      servicePath: `/${request.serviceId}`,
      environment: request.environment,
      providerId:
        "providerId" in request ? request.providerId : request.serviceId,
      owner: request.owner,
      ...(context ? { audit: context } : {}),
    },
  };
}

function serviceRegistrationBody(): SchemaRegistrationRequest {
  return {
    serviceId: "checkout",
    environment: "default",
    owner: { name: "Checkout", contact: "checkout@example.com" },
    schema: settingsSchema,
    fragmentSlots: [],
  };
}

function fragmentRegistrationBody(): SchemaRegistrationRequest {
  return {
    serviceId: "checkout",
    providerId: "checkout-plugin",
    slotPath: "/plugins",
    environment: "default",
    owner: { name: "Checkout", contact: "checkout@example.com" },
    schema: settingsSchema,
  };
}

function createServiceCallCounts(): ServiceCallCounts {
  return {
    registeredObjectWrites: 0,
    registeredPathPatches: 0,
    effectiveValidations: 0,
  };
}

function createRegistryCallCounts(): RegistryCallCounts {
  return { registrations: 0, lists: 0 };
}

function createAuthGateCallCounts(): AuthGateCallCounts {
  return { contextConversions: 0, readChecks: 0, writeChecks: 0 };
}

function expectNoServiceCalls(calls: ServiceCallCounts): void {
  expect(calls.registeredObjectWrites).toBe(0);
  expect(calls.registeredPathPatches).toBe(0);
  expect(calls.effectiveValidations).toBe(0);
}

function expectNoRegistryCalls(calls: RegistryCallCounts): void {
  expect(calls.registrations).toBe(0);
  expect(calls.lists).toBe(0);
}

function expectNoAuthGateCalls(calls: AuthGateCallCounts): void {
  expect(calls.contextConversions).toBe(0);
  expect(calls.readChecks).toBe(0);
  expect(calls.writeChecks).toBe(0);
}
