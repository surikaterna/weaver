import { vi } from "vitest";
import { ZodError } from "zod";
import { internalRegistrationId, internalRegistrationRecordSchema, internalCatalogSchema } from "@weaver-conf/config-types";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { record } from "../validated-fixtures.mjs";
import { registryFixture } from "./registry-fixture.mjs";

const owner = { name: "svc", contact: "svc@example.com" };
const request = (schema = { type: "object" }, serviceId = "svc") => ({ serviceId, environment: "dev", owner, schema, fragmentSlots: [] });
const unsafeEnvironments = ["__proto__", "constructor", "prototype", "", " dev", "dev/prod", "dev:prod"];

async function fixture(profile = "memory") {
  const f = await registryFixture(profile);
  const registry = createSchemaRegistry({ configService: f.service });
  return { ...f, registry };
}

async function corruptionRejected(f, change) {
  await f.service.close();
  const state = structuredClone((await f.platform.load()).entries._weaver);
  change(state);
  expect((await f.platform.write("_weaver", state)).success).toBe(true);
  const before = (await f.platform.load()).entries;
  await expect(createWeaverConfigService({ providers: f.providers, environment: "dev" })).rejects.toThrow();
  expect((await f.platform.load()).entries).toEqual(before);
}

describe("Canonical SchemaRegistry", () => {
  test("register new schema succeeds with isNewSchema true", async () => {
    const f = await fixture();
    try {
      const result = await f.registry.register(request({ type: "object", properties: { port: { type: "number", default: 3000 } } }));
      expect(result).toMatchObject({ success: true, isNewSchema: true, hasBreakingChanges: false });
    } finally { await f.service.close(); }
  });

  for (const profile of ["memory", "fs"]) test(`registry rejects unsafe environments without effects (${profile})`, async () => {
    const f = await fixture(profile);
    try {
      const before = (await f.platform.load()).entries;
      for (const environment of [...unsafeEnvironments, 42]) {
        expect(await f.registry.register({ ...request(), environment })).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
      }
      expect((await f.platform.load()).entries).toEqual(before);
      expect(f.registry.listAll()).toEqual({});
    } finally { await f.service.close(); }
  });

  test("canonical records reject unsafe environment keys without prototype effects", () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    for (const environment of unsafeEnvironments) {
      expect(() => internalRegistrationRecordSchema.parse({ version: 1, kind: "service", request: { ...request(), environment }, audit: { actor: "test" } })).toThrow(ZodError);
    }
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  });

  test.each(unsafeEnvironments)("canonical hydration rejects unsafe request environment %j without mutation", async (environment) => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const f = await fixture("fs");
    await corruptionRejected(f, (state) => {
      const item = record("svc", { type: "object" });
      const id = internalRegistrationId(item);
      item.request.environment = environment;
      state.catalog.registrations[id] = item;
    });
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  });

  test("canonical registry refuses alternate environment/storage options", async () => {
    const f = await fixture();
    try {
      for (const environment of ["__proto__", "other"]) expect(() => createSchemaRegistry({ configService: f.service, environment })).toThrow();
    } finally { await f.service.close(); }
  });

  test("canonical hydration refuses obsolete aggregate shape", () => {
    expect(() => internalCatalogSchema.parse({ environments: {} })).toThrow();
  });

  test("unchanged service registration is idempotent", async () => {
    const f = await fixture();
    try {
      await f.registry.register(request());
      const revision = f.service.revision;
      expect(await f.registry.register(request())).toMatchObject({ success: true, isNewSchema: false });
      expect(f.service.revision).toBe(revision);
    } finally { await f.service.close(); }
  });

  test("non-object and ambiguous service roots are rejected", async () => {
    const f = await fixture();
    try {
      for (const schema of [{ type: "string" }, { type: "array" }, {}, { type: ["object", "null"] }]) expect((await f.registry.register(request(schema))).success).toBe(false);
      expect(f.registry.listAll()).toEqual({});
    } finally { await f.service.close(); }
  });

  test("non-object and ambiguous fragment roots are rejected", async () => {
    const f = await fixture();
    try {
      await f.registry.register({ ...request(), fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }] });
      for (const schema of [{ type: "string" }, { type: "array" }, {}, { type: ["object", "null"] }]) {
        expect((await f.registry.register({ serviceId: "svc", environment: "dev", owner, providerId: "plugin", slotPath: "/plugins", schema })).success).toBe(false);
      }
    } finally { await f.service.close(); }
  });

  test("conditional removal reports breaking compatibility conservatively", async () => {
    const f = await fixture();
    try {
      await f.registry.register(request({ type: "object", properties: { port: { type: "number" } } }));
      expect(await f.registry.register(request(), { expectedRevision: f.service.revision })).toMatchObject({ success: true, hasBreakingChanges: true, compatibility: "breaking" });
    } finally { await f.service.close(); }
  });

  test("getSchema returns a detached registered schema", async () => {
    const f = await fixture();
    try {
      await f.registry.register(request());
      const schema = await f.registry.getSchema("svc", "dev");
      schema.type = "string";
      expect((await f.registry.getSchema("svc", "dev")).type).toBe("object");
    } finally { await f.service.close(); }
  });

  test("getSchema returns null for unknown service", async () => {
    const f = await fixture();
    try { expect(await f.registry.getSchema("missing", "dev")).toBeNull(); }
    finally { await f.service.close(); }
  });

  test("persistent registry writes only canonical registration records", async () => {
    const f = await fixture("fs");
    try {
      await f.registry.register(request(), { actor: "operator" });
      const raw = (await f.platform.load()).entries._weaver;
      expect(raw.registry).toBeUndefined();
      expect(Object.values(raw.catalog.registrations)).toEqual([{ version: 1, kind: "service", request: request(), audit: { actor: "operator" } }]);
    } finally { await f.service.close(); }
  });

  test("registry persistence publishes only the effective service root", async () => {
    const f = await fixture("fs");
    const events = [];
    f.service.onDelta((event) => events.push(event));
    try {
      await f.registry.register(request());
      expect(events).toHaveLength(1);
      expect(events[0].key).toBe("svc");
      expect(JSON.stringify(events)).not.toContain("_weaver");
    } finally { await f.service.close(); }
  });

  test("throwing listeners do not reverse committed registrations", async () => {
    const f = await fixture("fs");
    f.service.onDelta(() => { throw new Error("listener"); });
    try {
      expect((await f.registry.register(request())).success).toBe(true);
      expect(await f.registry.getSchema("svc", "dev")).toEqual({ type: "object" });
    } finally { await f.service.close(); }
  });

  test("registration and mutation publish in coordinator commit order", async () => {
    const f = await fixture();
    const events = [];
    f.service.onDelta((event) => events.push(event));
    try {
      const results = await Promise.all([f.registry.register(request({ type: "object", properties: { ready: { type: "boolean" } }, additionalProperties: false })), f.service.set("platform", "svc", { ready: true })]);
      expect(results.every((result) => result.success)).toBe(true);
      expect(events.map((event) => event.action)).toEqual(["remove", "set"]);
      expect(events[1].value).toEqual({ ready: true });
    } finally { await f.service.close(); }
  });

  test("canonical registrations reconstruct after ownership transfer/restart", async () => {
    const f = await fixture("fs");
    await f.registry.register(request());
    await f.service.close();
    const service = await createWeaverConfigService({ providers: f.providers, environment: "dev" });
    try { expect(createSchemaRegistry({ configService: service }).listAll()).toHaveProperty("/svc:dev"); }
    finally { await service.close(); }
  });

  test("hydration refuses an invalid canonical service root", async () => {
    const f = await fixture("fs");
    await corruptionRejected(f, (state) => {
      const item = record("svc", { type: "object" });
      const id = internalRegistrationId(item);
      item.request.schema = { type: "number" };
      state.catalog.registrations[id] = item;
    });
  });

  test("hydration refuses an invalid canonical fragment root", async () => {
    const f = await fixture("fs");
    await corruptionRejected(f, (state) => {
      const item = { version: 1, kind: "fragment", request: { serviceId: "svc", environment: "dev", owner, providerId: "plugin", slotPath: "/plugins", schema: { type: "string" } }, audit: { actor: "operator" } };
      state.catalog.registrations[internalRegistrationId(item)] = item;
    });
  });

  test("invalid control roots cannot initialize a registry", async () => {
    const f = await fixture();
    await corruptionRejected(f, (state) => { state.catalog = "invalid"; });
  });

  test("dangerous service and slot identities cannot mutate prototypes", async () => {
    const f = await fixture();
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    try {
      for (const serviceId of ["__proto__", "constructor", "prototype", "/_weaver"]) expect((await f.registry.register(request({ type: "object" }, serviceId))).success).toBe(false);
      for (const slotPath of ["/__proto__", "/constructor", "/prototype"]) expect((await f.registry.register({ ...request(), fragmentSlots: [{ slotPath, accepts: "object" }] })).success).toBe(false);
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
    } finally { await f.service.close(); }
  });

  test("safe record IDs cannot hide contradictory or dangerous request metadata", async () => {
    const f = await fixture();
    await corruptionRejected(f, (state) => {
      const item = record("svc", { type: "object" });
      const id = internalRegistrationId(item);
      item.request.serviceId = "constructor";
      state.catalog.registrations[id] = item;
    });
  });

  test("legacy target fields are rejected, not used as independent path authority", async () => {
    const f = await fixture();
    try { expect((await f.registry.register({ ...request(), path: "/other", namespace: "other" })).success).toBe(false); }
    finally { await f.service.close(); }
  });

  test("failed persistence leaves durable and projected records unchanged", async () => {
    const f = await fixture("fs");
    const before = (await f.platform.load()).entries;
    const fault = vi.spyOn(f.platform.authority, "commitLayer").mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "injected" } });
    try {
      expect((await f.registry.register(request())).success).toBe(false);
      expect(f.registry.listAll()).toEqual({});
      expect((await f.platform.load()).entries).toEqual(before);
    } finally { fault.mockRestore(); await f.service.close(); }
  });
});
