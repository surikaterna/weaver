import { createAuditService } from "../../src/audit/audit-service.ts";
import { createWeaverScompService } from "../../src/transport/scomp-service.ts";

const prefix = "weaver-config-v1";
const route = (name) => `${prefix}.${name}`;

describe("SCOMP schema operation audit", () => {
  test("emits one canonical event for every successful operation", async () => {
    const audit = auditCapture();
    const service = createWeaverScompService({
      ...mockDeps(),
      auditService: audit.service,
      defaultEnvironment: "default",
    });

    await invoke(service, "registerSchema", serviceRegistration());
    await invoke(service, "registerSchema", fragmentRegistration());
    await invoke(service, "setRegisteredObject", {
      anchorPath: "/checkout",
      environment: "prod",
      value: { enabled: true },
    });
    await invoke(service, "patchRegisteredPath", {
      path: "/checkout/enabled",
      environment: "prod",
      value: false,
    });
    await invoke(service, "validateRegisteredEffective", {
      anchorPath: "/checkout",
      environment: "prod",
    });

    expect(audit.entries).toHaveLength(5);
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "schema.register.service",
      "schema.register.fragment",
      "schema.write.object",
      "schema.patch.path",
      "schema.validate.effective",
    ]);
    expect(audit.entries.every((entry) => entry.actor === "scomp:transport")).toBe(true);
    expect(audit.entries.every((entry) => entry.metadata.subject === "scomp:transport")).toBe(true);
    expect(audit.entries[3]).toMatchObject({
      key: "/checkout/enabled",
      environment: "prod",
      success: true,
      metadata: { writePath: "/checkout/enabled" },
    });
  });

  test("emits exactly one failure event for a typed service failure", async () => {
    const audit = auditCapture();
    const deps = mockDeps();
    deps.configService.setRegisteredObject = async () => ({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "schema rejected value" },
    });
    const service = createWeaverScompService({
      ...deps,
      auditService: audit.service,
    });

    const result = await invoke(service, "setRegisteredObject", {
      anchorPath: "/checkout",
      value: {},
    });

    expect(result.success).toBe(false);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        actor: "scomp:transport",
        success: false,
        error: "schema rejected value",
      }),
    ]);
  });

  test("ignores caller-supplied actor context", async () => {
    const audit = auditCapture();
    const service = createWeaverScompService({
      ...mockDeps(),
      auditService: audit.service,
    });

    await invoke(service, "registerSchema", {
      ...serviceRegistration(),
      actor: "spoofed",
    });

    expect(audit.entries).toEqual([
      expect.objectContaining({
        actor: "scomp:transport",
        metadata: expect.objectContaining({ subject: "scomp:transport" }),
      }),
    ]);
  });

  test("keeps operation success when an audit sink fails", async () => {
    const errors = [];
    const auditService = createAuditService({
      sinks: [{ record: async () => Promise.reject(new Error("sink down")) }],
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...args) => errors.push(args),
      },
    });
    const service = createWeaverScompService({
      ...mockDeps(),
      auditService,
    });

    const result = await invoke(service, "setRegisteredObject", {
      anchorPath: "/checkout",
      value: {},
    });

    expect(result.success).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

function auditCapture() {
  const entries = [];
  return {
    entries,
    service: { record: async (entry) => void entries.push(entry) },
  };
}

function mockDeps() {
  const success = async () => ({ success: true, revision: "test-rev" });
  return {
    configService: {
      providers: [],
      degradedProviders: [],
      revision: "test-rev",
      resolveAll: async () => snapshot(),
      get: async () => undefined,
      getNamespace: async () => ({}),
      inspect: async (key) => ({ key, layerValues: {} }),
      reloadProvider: async () => {},
      set: success,
      remove: success,
      onDelta: () => () => {},
      batch: async (operation) => operation(),
      setMany: success,
      setRegisteredObject: success,
      patchRegisteredPath: success,
      validateRegisteredEffective: async () => ({ valid: true, errors: [] }),
      flush: async () => {},
      refreshProviders: async () => {},
    },
    schemaRegistry: {
      register: async (request) => registrationSuccess(request),
      getSchema: async () => null,
      resolveAnchor: async () => null,
      listAll: () => ({}),
    },
    scopeManager: {
      listScopes: () => [],
      listScopeValues: () => [],
    },
  };
}

function snapshot() {
  return {
    entries: {},
    scopes: {},
    revision: "test-rev",
    timestamp: new Date().toISOString(),
  };
}

function registrationSuccess(request) {
  return {
    success: true,
    isNewSchema: true,
    hasBreakingChanges: false,
    metadata: {
      serviceId: request.serviceId,
      servicePath: `/${request.serviceId}`,
      environment: request.environment,
      providerId: request.providerId ?? request.serviceId,
      owner: request.owner,
    },
  };
}

function serviceRegistration() {
  return {
    serviceId: "checkout",
    environment: "prod",
    owner: { name: "Checkout", contact: "checkout@example.com" },
    schema: { type: "object" },
    fragmentSlots: [],
  };
}

function fragmentRegistration() {
  return {
    serviceId: "checkout",
    providerId: "billing-addon",
    slotPath: "/plugins",
    environment: "prod",
    owner: { name: "Billing", contact: "billing@example.com" },
    schema: { type: "object" },
  };
}

function invoke(service, name, input) {
  return service.router[route(name)].handler(input);
}
