import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
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
  const writes = [];
  const removes = [];
  return {
    id,
    layer,
    writable,
    writes,
    removes,
    async load() { return { entries: JSON.parse(JSON.stringify(data)) }; },
    async write(key, value) {
      writes.push({ key, value });
      deepSet(data, key, value);
      return { success: true };
    },
    async remove(key) {
      removes.push(key);
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

describe("createWeaverScompService", () => {
  test("normal SCOMP writes cannot bypass a bound registered schema", async () => {
    const provider = createTestProvider("p1", "platform", {
      checkout: { mode: "prod" },
    });
    const svc = await createWeaverConfigService({ providers: [provider], environment: "default" });
    const deps = buildScompDeps(svc);
    await deps.schemaRegistry.register({
      serviceId: "checkout",
      environment: "default",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema: {
        type: "object",
        required: ["mode"],
        properties: { mode: { type: "string", enum: ["prod", "test"] } },
        additionalProperties: false,
      },
      fragmentSlots: [],
    });
    const service = createWeaverScompService(deps);

    const direct = await service.router[route("set")].handler({
      layer: "platform",
      key: "checkout.mode",
      value: "invalid",
    });
    const batch = await service.router[route("setMany")].handler({
      layer: "platform",
      entries: { "safe.value": true, "checkout.mode": "invalid" },
    });
    const remove = await service.router[route("remove")].handler({
      layer: "platform",
      key: "checkout.mode",
    });
    const wrongEnvironment = await service.router[route("set")].handler({
      layer: "platform",
      key: "checkout.mode",
      value: "invalid",
      environment: "other",
    });
    const wrongEnvironmentRemove = await service.router[route("remove")].handler({
      layer: "platform",
      key: "checkout.mode",
      environment: "other",
    });
    const duplicateBatch = await service.router[route("setMany")].handler({
      layer: "platform",
      entries: { "checkout.mode": "invalid", "checkout[mode]": "prod" },
    });

    expect([
      direct.success,
      batch.success,
      remove.success,
      wrongEnvironment.success,
      wrongEnvironmentRemove.success,
      duplicateBatch.success,
    ]).toEqual([false, false, false, false, false, false]);
    expect(provider.writes).toEqual([]);
    expect(provider.removes).toEqual([]);
  });

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

  test("registered operations preserve canonical metadata and anchor objects", async () => {
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
    const registered = await service.router[route("registerSchema")].handler({
      serviceId: "checkout",
      environment: "default",
      owner: { name: "Checkout", contact: "checkout@example.com" },
      schema,
      fragmentSlots: [],
    });
    expect(registered.metadata.servicePath).toBe("/checkout");

    await service.router[route("setRegisteredObject")].handler({
      anchorPath: "/checkout",
      value: { db: { host: "localhost", port: 5432 } },
      layer: "platform",
    });
    await service.router[route("patchRegisteredPath")].handler({
      path: "/checkout/db/host",
      value: "db.internal",
      layer: "platform",
    });
    const value = await svc.get("checkout");
    expect(value).toEqual({ db: { host: "db.internal", port: 5432 } });
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

  test("public read handlers do not expose protected metadata", async () => {
    const provider = createTestProvider("p1", "platform", {
      app: {
        name: "public",
        direct: { _weaver: "mount", source: "_weaver.registry.schemas" },
        bridge: { _weaver: "mount", source: "_weaver.registry.schemas" },
        chained: { _weaver: "mount", source: "app.bridge" },
      },
      _weaver: { registry: { schemas: "LEAK" } },
    });
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const service = createWeaverScompService(buildScompDeps(svc));

    const snapshot = await service.router[route("resolveAll")].handler({});
    const direct = await service.router[route("get")].handler({ key: "_weaver.registry.schemas" });
    const mounted = await service.router[route("get")].handler({ key: "app.direct" });
    const chained = await service.router[route("get")].handler({ key: "app.chained" });
    const namespace = await service.router[route("getNamespace")].handler({ prefix: "_weaver" });
    const inspection = await service.router[route("inspect")].handler({ key: "_weaver" });

    expect(snapshot.entries).toMatchObject({
      app: { name: "public", direct: undefined, chained: undefined },
    });
    expect(direct).toEqual({ value: undefined });
    expect(mounted).toEqual({ value: undefined });
    expect(chained).toEqual({ value: undefined });
    expect(namespace).toEqual({ entries: {} });
    expect(inspection.effectiveValue).toBe(undefined);
    expect(inspection.layerValues).toEqual({});
    expect(JSON.stringify({ snapshot, mounted, chained })).not.toContain("LEAK");
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
