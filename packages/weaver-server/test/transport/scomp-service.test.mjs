import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { createScopeManager } from "../../src/core/scope-manager.ts";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";
import { createScompTransport } from "@weaver-conf/transport-scomp";

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

function buildScompDeps(configService) {
  const schemaRegistry = createSchemaRegistry({ configService });
  const scopeManager = createScopeManager({ configService, schemaRegistry });
  return { configService, scopeManager, schemaRegistry };
}

const schemaFidelityFixture = {
  type: "object",
  required: ["targets"],
  properties: {
    targets: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      default: [{ name: "primary", weight: 1 }],
      items: {
        type: "object",
        required: ["name", "weight"],
        minProperties: 2,
        maxProperties: 2,
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            minLength: 2,
            maxLength: 20,
            pattern: "^[a-z-]+$",
          },
          weight: {
            type: "number",
            minimum: 0,
            maximum: 1,
            multipleOf: 0.1,
          },
        },
      },
    },
  },
  oneOf: [{ type: "object", required: ["targets"] }],
  anyOf: [{ type: "object", minProperties: 1 }],
  allOf: [{ type: "object", maxProperties: 3 }],
  not: { type: "null" },
  "x-weaver": {
    visibility: "admin",
    reloadBehavior: "hot",
    expressionAllowed: false,
  },
};

const schemaFidelityRequest = {
  serviceId: "example-service",
  environment: "dev",
  owner: {
    name: "Example Service",
    contact: "example-service@example.com",
  },
  schema: schemaFidelityFixture,
  schemaVersion: "1.2.3",
  fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
};

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
    const service = createWeaverScompService(buildScompDeps(svc));
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

  test("registration preserves the canonical schema across SCOMP boundaries", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });
    const deps = buildScompDeps(configService);
    const service = createWeaverScompService(deps);
    const peer = {
      consumes() {
        return {
          registerSchema: (request) =>
            service.router[route("registerSchema")].handler(request),
        };
      },
    };
    const transport = createScompTransport({ peer });

    const result = await transport.registerSchema(schemaFidelityRequest);

    expect(result.success).toBe(true);
    expect(result.metadata?.servicePath).toBe("/example-service");
    expect(await deps.schemaRegistry.getSchema("example-service", "dev")).toEqual(
      schemaFidelityFixture,
    );
    await transport.close();
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
