import type {
  ConfigAuditEntry,
  ObjectConfigurationPropertySchema,
  WriteResult,
} from "@weaver-conf/config-types";
import type { AuditService } from "../audit/audit-service";
import type { AuthContext } from "../auth/auth-middleware";
import type {
  SchemaWriteContext,
  WeaverConfigService,
} from "../core/config-service";
import type {
  SchemaRegistrationContext,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
  SchemaRegistry,
} from "../core/schema-registry";
import { createRestAdapter } from "./rest-adapter";

const settingsSchema: ObjectConfigurationPropertySchema = {
  type: "object",
  properties: { enabled: { type: "boolean" } },
  required: ["enabled"],
};

const authContext: AuthContext = {
  identity: {
    serviceId: "schema-admin-service",
    userId: "fallback-user",
    roles: [],
    claims: {},
  },
  isAdmin: true,
  isService: true,
  isUser: true,
};

interface Captures {
  readonly registrations: SchemaRegistrationContext[];
  readonly objectWrites: SchemaWriteContext[];
  readonly pathPatches: SchemaWriteContext[];
}

describe("REST schema route authorization/audit hook metadata", () => {
  it("passes subject and canonical registration metadata to hooks and audit", async () => {
    const captures = createCaptures();
    const audit = createAuditCapture();
    const adapter = createRestAdapter({
      configService: createMockConfigService(captures),
      schemaRegistry: createMockSchemaRegistry(captures),
      auditService: audit.service,
    });

    await adapter.handleRequest("POST", "/v1/admin/schemas/services", {
      params: {},
      query: {},
      body: serviceRegistrationBody(),
      headers: {},
      authContext,
    });
    await adapter.handleRequest("POST", "/v1/admin/schemas/fragments", {
      params: {},
      query: {},
      body: fragmentRegistrationBody(),
      headers: {},
      authContext,
    });

    expect(captures.registrations[0]?.operation).toMatchObject({
      operation: "schema.register.service",
      subject: "schema-admin-service",
      serviceId: "checkout",
      providerId: "checkout",
      servicePath: "/checkout",
      environment: "prod",
    });
    expect(captures.registrations[1]?.operation).toMatchObject({
      operation: "schema.register.fragment",
      subject: "schema-admin-service",
      serviceId: "checkout",
      providerId: "billing-addon",
      servicePath: "/checkout",
      canonicalSlotPath: "/checkout/plugins",
      fragmentPath: "/checkout/plugins/billing-addon",
      environment: "prod",
    });
    expect(audit.entries.map((entry) => entry.domain)).toEqual([
      "schema",
      "schema",
    ]);
    expect(audit.entries[0]).toMatchObject({
      action: "schema.register.service",
      actor: "schema-admin-service",
      metadata: { subject: "schema-admin-service" },
    });
  });

  it("passes subject and canonical write metadata to hooks and audit", async () => {
    const captures = createCaptures();
    const audit = createAuditCapture();
    const adapter = createRestAdapter({
      configService: createMockConfigService(captures),
      schemaRegistry: createMockSchemaRegistry(captures),
      auditService: audit.service,
    });

    await adapter.handleRequest("PUT", "/v1/registered/objects/checkout", {
      params: {},
      query: { layer: "platform", env: "prod" },
      body: { value: { enabled: true } },
      headers: {},
      authContext,
    });
    await adapter.handleRequest(
      "PATCH",
      "/v1/registered/paths/checkout/enabled",
      {
        params: {},
        query: { layer: "platform", env: "prod" },
        body: { value: false },
        headers: {},
        authContext,
      },
    );

    expect(captures.objectWrites[0]?.schemaOperation).toMatchObject({
      operation: "schema.write.object",
      subject: "schema-admin-service",
      serviceId: "checkout",
      writePath: "/checkout",
      environment: "prod",
    });
    expect(captures.pathPatches[0]?.schemaOperation).toMatchObject({
      operation: "schema.patch.path",
      subject: "schema-admin-service",
      serviceId: "checkout",
      writePath: "/checkout/enabled",
      environment: "prod",
    });
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "schema.write.object",
      "schema.patch.path",
    ]);
  });
});

function createCaptures(): Captures {
  return { registrations: [], objectWrites: [], pathPatches: [] };
}

function createAuditCapture(): {
  readonly service: AuditService;
  readonly entries: ConfigAuditEntry[];
} {
  const entries: ConfigAuditEntry[] = [];
  return {
    entries,
    service: {
      record: async (entry) => {
        entries.push(entry);
      },
    },
  };
}

function createMockConfigService(captures: Captures): WeaverConfigService {
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
    setRegisteredObject: async (_layer, _path, _value, options) => {
      captures.objectWrites.push(options);
      return writeSuccess();
    },
    patchRegisteredPath: async (_layer, _path, _value, options) => {
      captures.pathPatches.push(options);
      return writeSuccess();
    },
    validateRegisteredEffective: async () => ({ valid: true, errors: [] }),
    flush: async () => {},
    refreshProviders: async () => {},
  };
}

function createMockSchemaRegistry(captures: Captures): SchemaRegistry {
  return {
    register: async (request, context) => {
      if (context) captures.registrations.push(context);
      return registrationSuccess(request);
    },
    getSchema: async () => null,
    resolveAnchor: async () => null,
    listAll: () => ({}),
  };
}

function writeSuccess(): WriteResult {
  return { success: true, revision: "test-rev" };
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

function serviceRegistrationBody(): SchemaRegistrationRequest {
  return {
    serviceId: "checkout",
    environment: "prod",
    owner: { name: "Checkout", contact: "checkout@example.com" },
    schema: settingsSchema,
    fragmentSlots: [],
  };
}

function fragmentRegistrationBody(): SchemaRegistrationRequest {
  return {
    serviceId: "checkout",
    providerId: "billing-addon",
    slotPath: "/plugins",
    environment: "prod",
    owner: { name: "Billing", contact: "billing@example.com" },
    schema: settingsSchema,
  };
}
