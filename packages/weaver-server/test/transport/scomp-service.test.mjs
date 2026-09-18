import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
import { createAuditService } from "../../src/audit/audit-service.ts";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { createScopeManager } from "../../src/core/scope-manager.ts";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";

const PREFIX = "weaver-config-v1";

function route(name) {
  return `${PREFIX}.${name}`;
}

function createTestProvider(id, layer, entries, writable = true) {
  let data = JSON.parse(JSON.stringify(entries));
  let writeCalls = 0;
  return {
    id,
    layer,
    writable,
    get writeCalls() { return writeCalls; },
    async load() { return { entries: JSON.parse(JSON.stringify(data)) }; },
    async write(key, value) {
      writeCalls += 1;
      deepSet(data, key, value);
      return { success: true };
    },
    async remove(key) {
      deepRemove(data, key);
      return { success: true };
    },
  };
}

function buildScompDeps(configService, defaultEnvironment = "dev") {
  const schemaRegistry = createSchemaRegistry({ configService });
  const scopeManager = createScopeManager({ configService, schemaRegistry });
  return { configService, scopeManager, schemaRegistry, defaultEnvironment };
}

describe("createWeaverScompService", () => {
  test("returns a ServiceDefinition with name and router", async () => {
    const provider = createTestProvider("p1", "platform", { app: { name: "test" } });
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    expect(service).toBeTruthy();
    expect(service.name).toBe(PREFIX);
    expect(service.router).toBeTruthy();
  });

  test("router contains all contract method routes", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    const routes = Object.keys(service.router);
    const expected = [
      "resolveAll", "get", "getNamespace", "inspect", "set", "setMany",
      "remove", "listScopes", "listScopeValues", "fetchSchemas",
      "registerSchema", "setRegisteredObject", "patchRegisteredPath",
      "validateRegisteredEffective", "subscribe",
    ];
    for (const name of expected) {
      expect(routes.includes(route(name))).toBeTruthy();
    }
    expect(routes.length).toBe(expected.length);
  });

  test("registered handlers delegate once and preserve anchor objects", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "default" });
    const service = createWeaverScompService(buildScompDeps(svc, "default"));
    const schema = {
      type: "object",
      properties: {
        db: {
          type: "object",
          properties: { host: { type: "string" }, port: { type: "integer" } },
          required: ["host", "port"],
        },
      },
      required: ["db"],
    };
    await service.router[route("registerSchema")].handler({
      serviceId: "checkout",
      environment: "default",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema,
      fragmentSlots: [],
    });

    const write = await service.router[route("setRegisteredObject")].handler({
      anchorPath: "/checkout",
      value: { db: { host: "localhost", port: 5432 } },
      layer: "platform",
    });
    const patch = await service.router[route("patchRegisteredPath")].handler({
      path: "/checkout/db/host",
      value: "db.internal",
      layer: "platform",
    });
    const validation = await service.router[route("validateRegisteredEffective")].handler({
      anchorPath: "/checkout",
    });

    expect(write.success).toBe(true);
    expect(patch.success).toBe(true);
    expect(validation).toEqual({ valid: true, errors: [] });
    expect(provider.writeCalls).toBe(2);
    expect(await svc.get("checkout")).toEqual({
      db: { host: "db.internal", port: 5432 },
    });
  });

  test("missing anchors fail without provider effects", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "default" });
    const service = createWeaverScompService(buildScompDeps(svc));

    const result = await service.router[route("setRegisteredObject")].handler({
      anchorPath: "/missing",
      value: {},
      layer: "platform",
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(provider.writeCalls).toBe(0);
  });

  test("registered handlers reject malformed service responses", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "default" });
    let calls = 0;
    svc.setRegisteredObject = async () => {
      calls += 1;
      return { success: "yes" };
    };
    const service = createWeaverScompService(buildScompDeps(svc));

    await expect(service.router[route("setRegisteredObject")].handler({
      anchorPath: "checkout",
      value: {},
    })).rejects.toThrow();
    expect(calls).toBe(0);

    await expect(service.router[route("setRegisteredObject")].handler({
      anchorPath: "/checkout",
      value: {},
    })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("resolveAll handler returns snapshot", async () => {
    const provider = createTestProvider("p1", "platform", { app: { port: 3000 } });
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    const result = await service.router[route("resolveAll")].handler({});
    expect(result.entries).toBeTruthy();
    expect(result.entries.app.port).toBe(3000);
    expect(result.revision).toBeTruthy();
  });

  test("get handler returns value", async () => {
    const provider = createTestProvider("p1", "platform", { db: { host: "localhost" } });
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    const result = await service.router[route("get")].handler({ key: "db.host" });
    expect(result).toEqual({ value: "localhost" });
  });

  test("set handler writes and succeeds", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    const result = await service.router[route("set")].handler({ key: "app.name", value: "hello", layer: "platform" });
    expect(result.success).toBe(true);
    const get = await service.router[route("get")].handler({ key: "app.name" });
    expect(get).toEqual({ value: "hello" });
  });

  test("remove handler deletes key", async () => {
    const provider = createTestProvider("p1", "platform", { x: 1 });
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    const result = await service.router[route("remove")].handler({ key: "x", layer: "platform" });
    expect(result.success).toBe(true);
    const get = await service.router[route("get")].handler({ key: "x" });
    expect(get).toEqual({ value: undefined });
  });

  test("subscribe handler yields deltas", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    const feed = service.router[route("subscribe")].handler({});

    setTimeout(() => svc.set("platform", "key1", "val1"), 10);

    const iterator = feed[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.key).toBe("key1");
    expect(first.value.value).toBe("val1");
    await iterator.return();
  });

  test("route kinds are classified correctly", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));
    expect(service.router[route("resolveAll")].kind).toBe("request");
    expect(service.router[route("get")].kind).toBe("request");
    expect(service.router[route("set")].kind).toBe("request");
    expect(service.router[route("subscribe")].kind).toBe("request"); // scomp handles feed semantics at proxy layer
  });
});

describe("SCOMP schema operation audit", () => {
  test("uses trusted identity and canonical operation context", async () => {
    const audit = auditCapture();
    const deps = mockScompDeps();
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
    const service = createWeaverScompService({ ...deps, auditService: audit.service });

    await service.router[route("registerSchema")].handler(serviceRegistration());
    await service.router[route("registerSchema")].handler(fragmentRegistration());
    await service.router[route("setRegisteredObject")].handler({ anchorPath: "/checkout/", value: {} });
    await service.router[route("patchRegisteredPath")].handler({ path: "/checkout/enabled/", value: true });
    await service.router[route("validateRegisteredEffective")].handler({ anchorPath: "/checkout/" });

    expect(calls).toEqual([
      ["object", "/checkout", "prod"],
      ["patch", "/checkout/enabled", "prod"],
      ["validate", "/checkout", "prod"],
    ]);
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "schema.register.service", "schema.register.fragment", "schema.write.object",
      "schema.patch.path", "schema.validate.effective",
    ]);
    expect(audit.entries.every((entry) => entry.actor === "scomp:transport")).toBe(true);
    expect(audit.entries.slice(2).map(({ key, environment, metadata }) => [
      key, environment, metadata.writePath,
    ])).toEqual([
      ["/checkout", "prod", "/checkout"],
      ["/checkout/enabled", "prod", "/checkout/enabled"],
      ["/checkout", "prod", "/checkout"],
    ]);
  });

  test("audits every typed, thrown, and malformed schema outcome once", async () => {
    const scenarios = [
      { kind: "typed", error: null },
      { kind: "thrown", error: "Schema operation failed unexpectedly" },
      { kind: "malformed", error: "Schema operation returned malformed response" },
    ];
    for (const operation of schemaAuditCases()) {
      for (const scenario of scenarios) {
        const audit = auditCapture();
        const deps = mockScompDeps();
        const primaryError = new Error(`provider-secret-${operation.action}`);
        let calls = 0;
        operation.install(deps, async () => {
          calls += 1;
          if (scenario.kind === "thrown") throw primaryError;
          if (scenario.kind === "malformed") return { secretPayload: true };
          return operation.failure;
        });
        const service = createWeaverScompService({ ...deps, auditService: audit.service });

        let result;
        let caught;
        try {
          result = await service.router[route(operation.name)].handler(operation.input);
        } catch (error) {
          caught = error;
        }

        expect(calls).toBe(1);
        if (scenario.kind === "typed") expect(result).toEqual(operation.failure);
        if (scenario.kind === "thrown") expect(caught).toBe(primaryError);
        if (scenario.kind === "malformed") expect(caught).toBeInstanceOf(Error);
        expect(audit.entries).toEqual([
          expect.objectContaining({
            action: operation.action,
            success: false,
            error: scenario.error ?? operation.failureError,
          }),
        ]);
        expect(JSON.stringify(audit.entries[0])).not.toContain("secret");
      }
    }
  });

  test("a rejecting sink preserves the primary error without replay", async () => {
    const errors = [];
    const auditService = createAuditService({
      sinks: [{ record: async () => Promise.reject(new Error("sink down")) }],
      logger: {
        debug: () => {}, info: () => {}, warn: () => {},
        error: (...args) => errors.push(args),
      },
    });
    const deps = mockScompDeps();
    const primaryError = new Error("provider secret");
    let calls = 0;
    deps.configService.setRegisteredObject = async () => {
      calls += 1;
      throw primaryError;
    };
    const service = createWeaverScompService({ ...deps, auditService });

    let caught;
    try {
      await service.router[route("setRegisteredObject")].handler({
        anchorPath: "/checkout", value: {},
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

function mockScompDeps() {
  const success = async () => ({ success: true, revision: "test-rev" });
  return {
    defaultEnvironment: "prod",
    configService: {
      providers: [], degradedProviders: [], revision: "test-rev",
      resolveAll: async () => ({ entries: {}, scopes: {}, revision: "test-rev", timestamp: new Date().toISOString() }),
      get: async () => undefined, getNamespace: async () => ({}),
      inspect: async (key) => ({ key, layerValues: {} }),
      reloadProvider: async () => {}, set: success, remove: success,
      onDelta: () => () => {}, batch: async (operation) => operation(),
      setMany: success, setRegisteredObject: success, patchRegisteredPath: success,
      validateRegisteredEffective: async () => ({ valid: true, errors: [] }),
      flush: async () => {}, refreshProviders: async () => {},
    },
    schemaRegistry: {
      register: async (request) => registrationSuccess(request),
      getSchema: async () => null, resolveAnchor: async () => null, listAll: () => ({}),
    },
    scopeManager: { listScopes: () => [], listScopeValues: () => [] },
  };
}

function schemaAuditCases() {
  return [
    auditCase("schema.register.service", "registerSchema", serviceRegistration(), "schemaRegistry", "register", registrationFailure("service rejected"), "service rejected"),
    auditCase("schema.register.fragment", "registerSchema", fragmentRegistration(), "schemaRegistry", "register", registrationFailure("fragment rejected"), "fragment rejected"),
    auditCase("schema.write.object", "setRegisteredObject", { anchorPath: "/checkout", value: {} }, "configService", "setRegisteredObject", writeFailure("object rejected"), "object rejected"),
    auditCase("schema.patch.path", "patchRegisteredPath", { path: "/checkout/enabled", value: true }, "configService", "patchRegisteredPath", writeFailure("patch rejected"), "patch rejected"),
    auditCase("schema.validate.effective", "validateRegisteredEffective", { anchorPath: "/checkout" }, "configService", "validateRegisteredEffective", { valid: false, errors: [] }, "Registered effective validation failed"),
  ];
}

function auditCase(action, name, input, target, method, failure, failureError) {
  return {
    action, name, input, failure, failureError,
    install: (deps, implementation) => { deps[target][method] = implementation; },
  };
}

function registrationFailure(message) {
  return {
    success: false, isNewSchema: false, hasBreakingChanges: false,
    error: { code: "VALIDATION_ERROR", message },
  };
}

function writeFailure(message) {
  return { success: false, error: { code: "VALIDATION_ERROR", message } };
}

function registrationSuccess(request) {
  return {
    success: true, isNewSchema: true, hasBreakingChanges: false,
    metadata: {
      serviceId: request.serviceId, servicePath: `/${request.serviceId}`,
      environment: request.environment, providerId: request.providerId ?? request.serviceId,
      owner: request.owner,
    },
  };
}

function serviceRegistration() {
  return {
    serviceId: "checkout", environment: "prod",
    owner: { name: "Checkout", contact: "checkout@example.com" },
    schema: { type: "object" }, fragmentSlots: [],
  };
}

function fragmentRegistration() {
  return {
    serviceId: "checkout", providerId: "billing-addon", slotPath: "/plugins",
    environment: "prod", owner: { name: "Billing", contact: "billing@example.com" },
    schema: { type: "object" },
  };
}
