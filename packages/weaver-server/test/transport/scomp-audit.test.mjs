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

  test("uses one canonical path and trusted default environment", async () => {
    const audit = auditCapture();
    const deps = mockDeps();
    const calls = [];
    deps.configService.setRegisteredObject = async (_layer, path, _value, options) => {
      calls.push(["object", path, options.environment]);
      return { success: true, revision: "object-rev" };
    };
    deps.configService.patchRegisteredPath = async (_layer, path, _value, options) => {
      calls.push(["patch", path, options.environment]);
      return { success: true, revision: "patch-rev" };
    };
    deps.configService.validateRegisteredEffective = async (path, context) => {
      calls.push(["validate", path, context.environment]);
      return { valid: true, errors: [] };
    };
    const service = createWeaverScompService({
      ...deps,
      auditService: audit.service,
      defaultEnvironment: "prod",
    });

    await invoke(service, "setRegisteredObject", { anchorPath: "/checkout/", value: {} });
    await invoke(service, "patchRegisteredPath", { path: "/checkout/enabled/", value: true });
    await invoke(service, "validateRegisteredEffective", { anchorPath: "/checkout/" });

    expect(calls).toEqual([
      ["object", "/checkout", "prod"],
      ["patch", "/checkout/enabled", "prod"],
      ["validate", "/checkout", "prod"],
    ]);
    expect(audit.entries.map(({ key, environment, metadata }) => [
      key, environment, metadata.writePath,
    ])).toEqual([
      ["/checkout", "prod", "/checkout"],
      ["/checkout/enabled", "prod", "/checkout/enabled"],
      ["/checkout", "prod", "/checkout"],
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

  test("audits thrown and malformed outcomes once for every schema action", async () => {
    const scenarios = [
      {
        auditError: "Schema operation failed unexpectedly",
        thrown: true,
      },
      {
        auditError: "Schema operation returned malformed response",
        thrown: false,
      },
    ];

    for (const operation of schemaOperationCases()) {
      for (const scenario of scenarios) {
        const audit = auditCapture();
        const deps = mockDeps();
        const primaryError = new Error(`provider-secret-${operation.action}`);
        let calls = 0;
        operation.install(deps, async () => {
          calls += 1;
          if (scenario.thrown) throw primaryError;
          return { malformedPayload: `secret-${operation.action}` };
        });
        const service = createWeaverScompService({
          ...deps,
          auditService: audit.service,
        });

        let caught;
        try {
          await invoke(service, operation.name, operation.input);
        } catch (error) {
          caught = error;
        }

        expect(calls).toBe(1);
        if (scenario.thrown) expect(caught).toBe(primaryError);
        else expect(caught).toBeInstanceOf(Error);
        expect(audit.entries).toEqual([
          expect.objectContaining({
            action: operation.action,
            success: false,
            error: scenario.auditError,
          }),
        ]);
        expect(JSON.stringify(audit.entries[0])).not.toContain("secret-");
      }
    }
  });

  test("preserves typed failures for every schema action", async () => {
    for (const operation of schemaOperationCases()) {
      const audit = auditCapture();
      const deps = mockDeps();
      let calls = 0;
      operation.install(deps, async () => {
        calls += 1;
        return operation.failure;
      });
      const service = createWeaverScompService({
        ...deps,
        auditService: audit.service,
      });

      const result = await invoke(service, operation.name, operation.input);

      expect(result).toEqual(operation.failure);
      expect(calls).toBe(1);
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: operation.action,
          success: false,
          error: operation.failureError,
        }),
      ]);
    }
  });

  test("a rejecting sink cannot replace or replay a primary error", async () => {
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
    const deps = mockDeps();
    const primaryError = new Error("provider secret");
    let calls = 0;
    deps.configService.setRegisteredObject = async () => {
      calls += 1;
      throw primaryError;
    };
    const service = createWeaverScompService({ ...deps, auditService });

    let caught;
    try {
      await invoke(service, "setRegisteredObject", {
        anchorPath: "/checkout",
        value: {},
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(primaryError);
    expect(calls).toBe(1);
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
    defaultEnvironment: "prod",
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

function schemaOperationCases() {
  return [
    {
      action: "schema.register.service",
      name: "registerSchema",
      input: serviceRegistration(),
      failure: registrationFailure("service registration rejected"),
      failureError: "service registration rejected",
      install: (deps, implementation) => { deps.schemaRegistry.register = implementation; },
    },
    {
      action: "schema.register.fragment",
      name: "registerSchema",
      input: fragmentRegistration(),
      failure: registrationFailure("fragment registration rejected"),
      failureError: "fragment registration rejected",
      install: (deps, implementation) => { deps.schemaRegistry.register = implementation; },
    },
    {
      action: "schema.write.object",
      name: "setRegisteredObject",
      input: { anchorPath: "/checkout", value: {} },
      failure: writeFailure("object write rejected"),
      failureError: "object write rejected",
      install: (deps, implementation) => { deps.configService.setRegisteredObject = implementation; },
    },
    {
      action: "schema.patch.path",
      name: "patchRegisteredPath",
      input: { path: "/checkout/enabled", value: true },
      failure: writeFailure("path patch rejected"),
      failureError: "path patch rejected",
      install: (deps, implementation) => { deps.configService.patchRegisteredPath = implementation; },
    },
    {
      action: "schema.validate.effective",
      name: "validateRegisteredEffective",
      input: { anchorPath: "/checkout" },
      failure: { valid: false, errors: [] },
      failureError: "Registered effective validation failed",
      install: (deps, implementation) => { deps.configService.validateRegisteredEffective = implementation; },
    },
  ];
}

function registrationFailure(message) {
  return {
    success: false,
    isNewSchema: false,
    hasBreakingChanges: false,
    error: { code: "VALIDATION_ERROR", message },
  };
}

function writeFailure(message) {
  return {
    success: false,
    error: { code: "VALIDATION_ERROR", message },
  };
}

function invoke(service, name, input) {
  return service.router[route(name)].handler(input);
}
