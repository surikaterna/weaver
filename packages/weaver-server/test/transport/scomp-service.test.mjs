import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { createScopeManager } from "../../src/core/scope-manager.ts";
import { initialized, record } from "../validated-fixtures.mjs";

const PREFIX = "weaver-config-v1";
const route = (name) => `${PREFIX}.${name}`;
const admin = { identity: { userId: "admin", roles: ["admin"], claims: {} }, isAdmin: true, isService: false, isUser: true };
const appSchema = { type: "object", properties: { name: { type: "string" }, x: { type: "number" } }, additionalProperties: false };
const dbSchema = { type: "object", properties: { host: { type: "string" }, port: { type: "integer" } }, additionalProperties: false };
const checkoutSchema = { type: "object", required: ["db"], properties: { db: { ...dbSchema, required: ["host", "port"] } }, additionalProperties: false };

async function fixture(options = {}) {
  const f = await initialized({ records: [record("app", appSchema), record("db", dbSchema)], data: { app: { name: "test" }, db: { host: "localhost" } }, ...options });
  const schemaRegistry = createSchemaRegistry({ configService: f.service });
  const deps = { configService: f.service, schemaRegistry, scopeManager: createScopeManager({ configService: f.service }), getAuthContext: () => admin };
  const definition = createWeaverScompService(deps);
  return { ...f, deps, definition, call: (name, input) => definition.router[route(name)].handler(input) };
}

describe("createWeaverScompService", () => {
  test("normal SCOMP writes cannot bypass a registered schema", async () => {
    const f = await fixture({ records: [record("checkout", checkoutSchema)], data: { checkout: { db: { host: "db", port: 5432 } } } });
    try {
      const before = f.service.revision;
      for (const environment of [undefined, "other"]) {
        expect((await f.call("set", { key: "checkout.db.port", value: "bad", layer: "platform", environment })).success).toBe(false);
        expect((await f.call("remove", { key: "checkout.db.port", layer: "platform", environment })).success).toBe(false);
      }
      expect((await f.call("setMany", { entries: { "checkout.db.port": "bad" }, layer: "platform" })).success).toBe(false);
      expect(f.service.revision).toBe(before);
    } finally { await f.service.close(); }
  });

  test("returns a ServiceDefinition with name and router", async () => {
    const f = await fixture();
    try { expect(f.definition.name).toBe(PREFIX); expect(f.definition.router).toBeTruthy(); }
    finally { await f.service.close(); }
  });

  test("router contains every contract method", async () => {
    const f = await fixture();
    try {
      const names = ["resolveAll", "get", "getNamespace", "inspect", "set", "setMany", "remove", "listScopes", "listScopeValues", "fetchSchemas", "registerSchema", "setRegisteredObject", "patchRegisteredPath", "validateRegisteredEffective", "subscribe"];
      expect(Object.keys(f.definition.router).sort()).toEqual(names.map(route).sort());
    } finally { await f.service.close(); }
  });

  test("registered operations retain canonical metadata and complete anchor objects", async () => {
    const f = await fixture({ records: [], data: {} });
    try {
      const result = await f.call("registerSchema", record("checkout", checkoutSchema).request);
      expect(result.metadata.servicePath).toBe("/checkout");
      expect((await f.call("setRegisteredObject", { anchorPath: "/checkout", value: { db: { host: "localhost", port: 5432 } }, layer: "platform" })).success).toBe(true);
      expect((await f.call("patchRegisteredPath", { path: "/checkout/db/host", value: "db.internal", layer: "platform" })).success).toBe(true);
      expect(await f.service.get("checkout")).toEqual({ db: { host: "db.internal", port: 5432 } });
    } finally { await f.service.close(); }
  });

  test("registerSchema returns typed failures for unsafe environments", async () => {
    const f = await fixture({ records: [], data: {} });
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    try {
      for (const environment of ["__proto__", "constructor", "prototype", "", " dev", "dev/prod", "dev:prod", 42]) {
        expect(await f.call("registerSchema", { ...record("checkout", checkoutSchema).request, environment })).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
      }
      expect(f.deps.schemaRegistry.listAll()).toEqual({});
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
    } finally { await f.service.close(); }
  });

  test("resolveAll returns a validated snapshot", async () => {
    const f = await fixture();
    try { expect((await f.call("resolveAll", {})).entries).toEqual({ app: { name: "test" }, db: { host: "localhost" } }); }
    finally { await f.service.close(); }
  });

  test("resolveAll returns inherited effective scope state", async () => {
    const path = [{ scopeId: "tenant", value: "acme" }];
    const f = await fixture({ scopes: [{ id: "tenant", label: "Tenant" }], contexts: [{ scopePath: path, state: "active" }], scoped: { "tenant:acme": { app: { x: 1 } } } });
    try { expect((await f.call("resolveAll", { scope: "tenant:acme" })).scopes["tenant:acme"].app).toEqual({ name: "test", x: 1 }); }
    finally { await f.service.close(); }
  });

  test("incomplete registered writes are refused before invalid read state exists", async () => {
    const f = await fixture({ records: [record("checkout", checkoutSchema)], data: { checkout: { db: { host: "db", port: 5432 } } } });
    try {
      expect((await f.call("setRegisteredObject", { anchorPath: "/checkout", layer: "platform", value: { db: { host: "db" } } })).success).toBe(false);
      expect((await f.call("get", { key: "checkout.db.port" })).value).toBe(5432);
    } finally { await f.service.close(); }
  });

  test("registered object reads and feed projections are resolved", async () => {
    const f = await fixture({ records: [record("checkout", checkoutSchema), record("shared", { type: "object", additionalProperties: true })],
      data: { checkout: { db: { host: { _weaver: "mount", source: "shared.host" }, port: 5432 } }, shared: { host: { _weaver: "secret-ref", provider: "vault", uri: "host" } } },
      secretBackend: { resolve: async () => "db.internal" },
    });
    try {
      expect((await f.call("get", { key: "checkout" })).value).toEqual({ db: { host: "db.internal", port: 5432 } });
      expect(JSON.stringify(await f.call("resolveAll", {}))).not.toContain("_weaver");
    } finally { await f.service.close(); }
  });

  test("public reads cannot expose protected control state or aliases", async () => {
    const f = await fixture({ records: [record("app", { type: "object", additionalProperties: true, description: "LEAK" })], data: { app: { name: "public", alias: { _weaver: "mount", source: "_weaver.catalog.registrations" } } } });
    try {
      expect((await f.call("get", { key: "_weaver.catalog.registrations" })).value).toBeUndefined();
      expect((await f.call("get", { key: "app.alias" })).value).toBeUndefined();
      expect(JSON.stringify(await f.call("resolveAll", {}))).not.toContain("LEAK");
    } finally { await f.service.close(); }
  });

  test("get handler returns a declared value", async () => {
    const f = await fixture();
    try { expect(await f.call("get", { key: "db.host" })).toEqual({ value: "localhost" }); }
    finally { await f.service.close(); }
  });

  test("set handler writes valid declared values", async () => {
    const f = await fixture();
    try {
      expect((await f.call("set", { key: "app.name", value: "hello", layer: "platform" })).success).toBe(true);
      expect((await f.call("get", { key: "app.name" })).value).toBe("hello");
    } finally { await f.service.close(); }
  });

  test("remove handler removes an optional declared value", async () => {
    const f = await fixture();
    try {
      expect((await f.call("remove", { key: "app.name", layer: "platform" })).success).toBe(true);
      expect((await f.call("get", { key: "app.name" })).value).toBeUndefined();
    } finally { await f.service.close(); }
  });

  test("subscribe yields validated root projections", async () => {
    const f = await fixture();
    const iterator = f.call("subscribe", {})[Symbol.asyncIterator]();
    try {
      const next = iterator.next();
      await f.service.set("platform", "app.name", "updated");
      expect((await next).value).toMatchObject({ key: "app", value: { name: "updated" } });
    } finally { await iterator.return(); await f.service.close(); }
  });

  test("route kinds retain request/feed proxy classification", async () => {
    const f = await fixture();
    try { for (const name of ["get", "set", "resolveAll", "subscribe"]) expect(f.definition.router[route(name)].kind).toBe("request"); }
    finally { await f.service.close(); }
  });

  test("schema administration fails closed without host-authenticated admin identity", async () => {
    const f = await fixture();
    const denied = createWeaverScompService({ ...f.deps, getAuthContext: () => undefined });
    try {
      const before = f.service.revision;
      expect(await denied.router[route("registerSchema")].handler({ ...record("forged", appSchema).request, isAdmin: true })).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
      await expect(denied.router[route("fetchSchemas")].handler({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.service.revision).toBe(before);
    } finally { await f.service.close(); }
  });

  test("conditional schema revision reaches the canonical registry without being persisted in the request", async () => {
    const f = await fixture();
    try {
      const request = record("app", { ...appSchema, additionalProperties: true }).request;
      expect((await f.call("registerSchema", request)).error.code).toBe("REVISION_CONFLICT");
      expect((await f.call("registerSchema", { ...request, ifRevision: f.service.revision })).success).toBe(true);
      expect(JSON.stringify((await f.platform.load()).entries._weaver.catalog)).not.toContain("ifRevision");
    } finally { await f.service.close(); }
  });
});
