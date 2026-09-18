import type {
  ConfigAuditEntry,
  SchemaRegistrationRequest,
  WriteResult,
} from "@weaver-conf/config-types";
import type { AuditService } from "../audit/audit-service";
import { createAuditService } from "../audit/audit-service";
import type { AuthContext } from "../auth/auth-middleware";
import type { WeaverConfigService } from "../core/config-service";
import type {
  SchemaRegistrationResult,
  SchemaRegistry,
} from "../core/schema-registry";
import type { AuthGate } from "./auth-gate";
import { createRestAdapter } from "./rest-adapter";

const authContext: AuthContext = {
  identity: {
    serviceId: "schema-admin-service",
    userId: "ignored-user",
    roles: ["admin"],
    claims: {},
  },
  isAdmin: true,
  isService: true,
  isUser: true,
};

describe("REST schema operation audit", () => {
  it("emits one canonical event for every successful operation", async () => {
    const audit = createAuditCapture();
    const adapter = createRestAdapter({
      configService: createMockConfigService(),
      schemaRegistry: createMockSchemaRegistry(),
      auditService: audit.service,
      defaultEnvironment: "default",
    });

    await send(adapter, "POST", "/v1/admin/schemas/services", {
      body: serviceRegistration(),
    });
    await send(adapter, "POST", "/v1/admin/schemas/fragments", {
      body: fragmentRegistration(),
    });
    await send(adapter, "PUT", "/v1/registered/objects/checkout", {
      query: { layer: "platform", env: "prod" },
      body: { value: { enabled: true } },
    });
    await send(adapter, "PATCH", "/v1/registered/paths/checkout/enabled", {
      query: { layer: "platform", env: "prod" },
      body: { value: false },
    });
    await send(adapter, "GET", "/v1/registered/effective/checkout", {
      query: { env: "prod" },
    });

    expect(audit.entries).toHaveLength(5);
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "schema.register.service",
      "schema.register.fragment",
      "schema.write.object",
      "schema.patch.path",
      "schema.validate.effective",
    ]);
    expect(audit.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "schema-admin-service",
          key: "/checkout/plugins/billing-addon",
          environment: "prod",
          success: true,
          metadata: expect.objectContaining({
            subject: "schema-admin-service",
            canonicalSlotPath: "/checkout/plugins",
            fragmentPath: "/checkout/plugins/billing-addon",
          }),
        }),
        expect.objectContaining({
          key: "/checkout/enabled",
          metadata: expect.objectContaining({
            writePath: "/checkout/enabled",
          }),
        }),
      ]),
    );
  });

  it("emits one failure event for a typed service failure", async () => {
    const audit = createAuditCapture();
    const configService = createMockConfigService();
    configService.setRegisteredObject = async () => ({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "schema rejected value" },
    });
    const adapter = createRestAdapter({
      configService,
      schemaRegistry: createMockSchemaRegistry(),
      auditService: audit.service,
      defaultEnvironment: "default",
    });

    const response = await send(
      adapter,
      "PUT",
      "/v1/registered/objects/checkout",
      { body: { value: {} } },
    );

    expect(response.status).toBe(400);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: "schema.write.object",
        success: false,
        error: "schema rejected value",
      }),
    ]);
  });

  it("emits nothing for authorization denial or spoofed input", async () => {
    const audit = createAuditCapture();
    const adapter = createRestAdapter({
      configService: createMockConfigService(),
      schemaRegistry: createMockSchemaRegistry(),
      authGate: denyingGate(),
      auditService: audit.service,
      defaultEnvironment: "default",
    });

    const denied = await send(
      adapter,
      "PUT",
      "/v1/registered/objects/checkout",
      { body: { value: {} } },
    );
    const spoofAdapter = createRestAdapter({
      configService: createMockConfigService(),
      schemaRegistry: createMockSchemaRegistry(),
      authGate: allowingGate(),
      auditService: audit.service,
      defaultEnvironment: "default",
    });
    const spoofed = await send(
      spoofAdapter,
      "POST",
      "/v1/admin/schemas/services",
      { body: { ...serviceRegistration(), actor: "spoofed" } },
    );

    expect(denied.status).toBe(403);
    expect(spoofed.status).toBe(400);
    expect(audit.entries).toEqual([]);
  });

  it("preserves success when an audit sink fails", async () => {
    const errors: unknown[] = [];
    const auditService = createAuditService({
      sinks: [{ record: async () => Promise.reject(new Error("sink down")) }],
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...args) => errors.push(args),
      },
    });
    const adapter = createRestAdapter({
      configService: createMockConfigService(),
      schemaRegistry: createMockSchemaRegistry(),
      auditService,
      defaultEnvironment: "default",
    });

    const response = await send(
      adapter,
      "PUT",
      "/v1/registered/objects/checkout",
      { body: { value: {} } },
    );

    expect(response.status).toBe(200);
    expect(errors).toHaveLength(1);
  });
});

function createAuditCapture(): {
  readonly service: AuditService;
  readonly entries: ConfigAuditEntry[];
} {
  const entries: ConfigAuditEntry[] = [];
  return {
    entries,
    service: { record: async (entry) => void entries.push(entry) },
  };
}

function createMockConfigService(): WeaverConfigService {
  const success = async (): Promise<WriteResult> => ({
    success: true,
    revision: "test-rev",
  });
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
    inspect: async (key) => ({
      key,
      effectiveValue: undefined,
      effectiveLayer: undefined,
      layerValues: {},
    }),
    reloadProvider: async () => {},
    set: success,
    remove: success,
    onDelta: () => () => {},
    batch: async <T>(operation: () => Promise<T>) => operation(),
    setMany: success,
    setRegisteredObject: success,
    patchRegisteredPath: success,
    validateRegisteredEffective: async () => ({ valid: true, errors: [] }),
    flush: async () => {},
    refreshProviders: async () => {},
  };
}

function createMockSchemaRegistry(): SchemaRegistry {
  return {
    register: async (request, _context) => registrationSuccess(request),
    getSchema: async () => null,
    resolveAnchor: async () => null,
    listAll: () => ({}),
  };
}

function registrationSuccess(
  request: SchemaRegistrationRequest,
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
    },
  };
}

function denyingGate(): AuthGate {
  return {
    toAccessContext: () => ({ userId: "denied", roles: [] }),
    gateRead: () => forbidden(),
    gateWrite: () => forbidden(),
    filterVisible: (_context, entries) => entries,
  };
}

function allowingGate(): AuthGate {
  return {
    toAccessContext: () => ({ userId: "allowed", roles: ["admin"] }),
    gateRead: () => null,
    gateWrite: () => null,
    filterVisible: (_context, entries) => entries,
  };
}

function forbidden() {
  return { status: 403, body: { error: { code: "FORBIDDEN" } } };
}

async function send(
  adapter: ReturnType<typeof createRestAdapter>,
  method: string,
  path: string,
  request: { readonly query?: Record<string, string>; readonly body?: unknown },
) {
  return adapter.handleRequest(method, path, {
    params: {},
    query: request.query ?? {},
    headers: {},
    body: request.body,
    authContext,
  });
}

function serviceRegistration(): SchemaRegistrationRequest {
  return {
    serviceId: "checkout",
    environment: "prod",
    owner: { name: "Checkout", contact: "checkout@example.com" },
    schema: { type: "object" },
    fragmentSlots: [],
  };
}

function fragmentRegistration(): SchemaRegistrationRequest {
  return {
    serviceId: "checkout",
    providerId: "billing-addon",
    slotPath: "/plugins",
    environment: "prod",
    owner: { name: "Billing", contact: "billing@example.com" },
    schema: { type: "object" },
  };
}
