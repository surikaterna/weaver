import type {
  ConfigurationPropertySchema,
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
import type { RestResponse } from "./rest-adapter";
import { createRestAdapter } from "./rest-adapter";

const settingsSchema: ConfigurationPropertySchema = {
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

const authContext: AuthContext = {
  identity: { userId: "auditor", roles: [], claims: {} },
  isAdmin: false,
  isService: false,
  isUser: true,
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

interface DenyAuthGate {
  readonly gate: AuthGate;
  readonly readKeys: readonly string[];
  readonly writeRequests: ReadonlyArray<{
    readonly layer: string;
    readonly key: string;
  }>;
}

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

function createDenyAuthGate(): DenyAuthGate {
  const readKeys: string[] = [];
  const writeRequests: Array<{ readonly layer: string; readonly key: string }> =
    [];
  const gate: AuthGate = {
    toAccessContext: () => ({ userId: "auditor", roles: [] }),
    gateRead: (_accessCtx, key) => {
      readKeys.push(key);
      return forbiddenResponse("read denied");
    },
    gateWrite: (_accessCtx, layer, key) => {
      writeRequests.push({ layer, key });
      return forbiddenResponse("write denied");
    },
    filterVisible: () => ({}),
  };
  return { gate, readKeys, writeRequests };
}

function writeSuccess(): WriteResult {
  return { success: true, revision: "test-rev" };
}

function forbiddenResponse(message: string): RestResponse {
  return {
    status: 403,
    body: { error: { code: "FORBIDDEN", message } },
  };
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

describe("REST schema routes authGate denial", () => {
  it("denies schema listing before registry access", async () => {
    const serviceCalls = createServiceCallCounts();
    const registryCalls = createRegistryCallCounts();
    const authGate = createDenyAuthGate();
    const adapter = createRestAdapter({
      configService: createMockConfigService(serviceCalls),
      schemaRegistry: createMockSchemaRegistry(registryCalls),
      authGate: authGate.gate,
    });

    const res = await adapter.handleRequest("GET", "/v1/admin/schemas", {
      params: {},
      query: {},
      headers: {},
      authContext,
    });

    expect(res.status).toBe(403);
    expect(registryCalls.lists).toBe(0);
    expect(authGate.readKeys).toEqual([]);
  });

  it("denies service schema registration before registering schema", async () => {
    const serviceCalls = createServiceCallCounts();
    const registryCalls = createRegistryCallCounts();
    const authGate = createDenyAuthGate();
    const adapter = createRestAdapter({
      configService: createMockConfigService(serviceCalls),
      schemaRegistry: createMockSchemaRegistry(registryCalls),
      authGate: authGate.gate,
    });

    const res = await adapter.handleRequest(
      "POST",
      "/v1/admin/schemas/services",
      {
        params: {},
        query: {},
        body: serviceRegistrationBody(),
        headers: {},
        authContext,
      },
    );

    expect(res.status).toBe(403);
    expect(registryCalls.registrations).toBe(0);
    expect(authGate.writeRequests).toEqual([
      { layer: "admin", key: "_weaver.registry.schemas" },
    ]);
  });

  it("denies fragment schema registration before registering schema", async () => {
    const serviceCalls = createServiceCallCounts();
    const registryCalls = createRegistryCallCounts();
    const authGate = createDenyAuthGate();
    const adapter = createRestAdapter({
      configService: createMockConfigService(serviceCalls),
      schemaRegistry: createMockSchemaRegistry(registryCalls),
      authGate: authGate.gate,
    });

    const res = await adapter.handleRequest(
      "POST",
      "/v1/admin/schemas/fragments",
      {
        params: {},
        query: {},
        body: fragmentRegistrationBody(),
        headers: {},
        authContext,
      },
    );

    expect(res.status).toBe(403);
    expect(registryCalls.registrations).toBe(0);
    expect(authGate.writeRequests).toEqual([
      { layer: "admin", key: "_weaver.registry.schemas" },
    ]);
  });

  it("denies registered object writes before write side effects", async () => {
    const serviceCalls = createServiceCallCounts();
    const registryCalls = createRegistryCallCounts();
    const authGate = createDenyAuthGate();
    const adapter = createRestAdapter({
      configService: createMockConfigService(serviceCalls),
      schemaRegistry: createMockSchemaRegistry(registryCalls),
      authGate: authGate.gate,
    });

    const res = await adapter.handleRequest(
      "PUT",
      "/v1/registered/objects/checkout",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: { db: { host: "localhost", port: 5432 } } },
        headers: {},
        authContext,
      },
    );

    expect(res.status).toBe(403);
    expect(serviceCalls.registeredObjectWrites).toBe(0);
    expect(authGate.writeRequests).toEqual([
      { layer: "platform", key: "checkout" },
    ]);
  });

  it("denies registered path patches before write side effects", async () => {
    const serviceCalls = createServiceCallCounts();
    const registryCalls = createRegistryCallCounts();
    const authGate = createDenyAuthGate();
    const adapter = createRestAdapter({
      configService: createMockConfigService(serviceCalls),
      schemaRegistry: createMockSchemaRegistry(registryCalls),
      authGate: authGate.gate,
    });

    const res = await adapter.handleRequest(
      "PATCH",
      "/v1/registered/paths/checkout/db/host",
      {
        params: {},
        query: { layer: "platform" },
        body: { value: "db.internal" },
        headers: {},
        authContext,
      },
    );

    expect(res.status).toBe(403);
    expect(serviceCalls.registeredPathPatches).toBe(0);
    expect(authGate.writeRequests).toEqual([
      { layer: "platform", key: "checkout.db.host" },
    ]);
  });

  it("denies registered effective validation before validation side effects", async () => {
    const serviceCalls = createServiceCallCounts();
    const registryCalls = createRegistryCallCounts();
    const authGate = createDenyAuthGate();
    const adapter = createRestAdapter({
      configService: createMockConfigService(serviceCalls),
      schemaRegistry: createMockSchemaRegistry(registryCalls),
      authGate: authGate.gate,
    });

    const res = await adapter.handleRequest(
      "GET",
      "/v1/registered/effective/checkout",
      { params: {}, query: {}, headers: {}, authContext },
    );

    expect(res.status).toBe(403);
    expect(serviceCalls.effectiveValidations).toBe(0);
    expect(authGate.readKeys).toEqual(["checkout"]);
  });
});

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
