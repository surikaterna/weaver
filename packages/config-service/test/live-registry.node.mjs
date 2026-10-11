import assert from "node:assert/strict";
import test from "node:test";
import { createConfigurationService } from "../dist/index.js";
import { hosted, principal, readonlyHost } from "./fixtures/authority.mjs";
import { schemaClaims, persisted } from "./fixtures/live-registry.mjs";
import { MemoryProvider, options, registration, scopeOptions, deferred } from "./fixtures/memory.mjs";
import { writable, commands } from "./fixtures/writable-memory.mjs";

test("live metadata snapshot/page/detail and data writes use independent revisions", async () => {
  const setup = await writable();
  const { root, controller, input } = setup;
  const schemas = controller.forSchemas(controller.mint(schemaClaims(input)));
  try {
    const initial = schemas.snapshot(), page = schemas.list({ limit: 1 });
    assert.ok(Object.isFrozen(initial.anchors[0].schema.properties));
    assert.equal(initial.anchors.length, 4);
    assert.ok(page.page.nextCursor);
    assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "written" }))).success, true);
    assert.equal(schemas.revision, initial.revision);
    assert.doesNotThrow(() => schemas.list({ cursor: page.page.nextCursor }));
    assert.equal(schemas.get("/alpha/missing", "east").detail, null);
  } finally { await root.dispose(); }
});

test("service/fragment/slot registration, defaults and examples retain admin metadata", async () => {
  const input = options([new MemoryProvider("p", "base", { alpha: { flag: "before" } })], { schemas: [] });
  const { root, controller } = await hosted(input);
  const schemas = controller.forSchemas(controller.mint(schemaClaims(input)));
  const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
  try {
    const service = registration();
    service.fragmentSlots = [{ slotPath: "/plugins", accepts: "object" }];
    service.schema.properties.flag.default = "ADMIN-DEFAULT";
    service.schema.properties.flag.examples = ["ADMIN-EXAMPLE"];
    const result = await schemas.register(service, { ifRevision: schemas.revision });
    assert.equal(result.success, true);
    assert.equal(result.metadata.serviceId, "alpha");
    assert.equal(reader.get(["flag"]), "before");
    const fragment = { serviceId: "alpha", providerId: "plugin", environment: "east", slotPath: "/plugins",
      owner: service.owner, schema: { type: "object", properties: { enabled: { type: "boolean" } } } };
    assert.equal((await schemas.register(fragment)).success, true);
    const detail = schemas.get("/alpha", "east").detail;
    assert.equal(detail.schema.properties.flag.default, "ADMIN-DEFAULT");
    assert.deepEqual(detail.schema.properties.flag.examples, ["ADMIN-EXAMPLE"]);
    assert.equal(schemas.get("/alpha/plugins/plugin", "east").detail.kind, "fragment");
    assert.equal(schemas.snapshot().slots[0].canonicalSlotPath, "/alpha/plugins");
    const revision = schemas.revision, page = schemas.list({ limit: 1 });
    assert.equal((await schemas.register({ ...fragment, slotPath: "/absent" })).success, false);
    assert.equal(schemas.revision, revision);
    assert.doesNotThrow(() => schemas.list({ cursor: page.page.nextCursor }));
    assert.equal((await schemas.register(service, { ifRevision: "old" })).error.code, "REVISION_CONFLICT");
    assert.equal((await schemas.register(service)).success, true);
    assert.throws(() => schemas.list({ cursor: page.page.nextCursor }), { code: "REVISION_CONFLICT" });
    assert.throws(() => schemas.get("/alpha", "east", { ifRevision: revision }), { code: "REVISION_CONFLICT" });
  } finally { await root.dispose(); }
});

test("classification changes replace every ready projection and future preloads without validating old values", async () => {
  const setup = scopeOptions(), { root, controller } = await hosted(setup.input);
  const readerClaims = principal(setup.input);
  readerClaims.grants.push(...[setup.path1, setup.path2].map((scopePath) => ({ ...readerClaims.grants[0], identity: { environment: "east", scopePath } })));
  const reader = controller.forIdentity(controller.mint(readerClaims), { identity: setup.input.identity, namespace: "/alpha" });
  const schemas = controller.forSchemas(controller.mint(schemaClaims(setup.input)));
  try {
    await reader.withScope(setup.path1).prepare();
    const claims = principal(setup.input); claims.grants[0].identity.scopePath = setup.path1;
    const port = controller.forIdentity(controller.mint(claims), { identity: claims.grants[0].identity, namespace: "/alpha" });
    assert.equal(port.get(["flag"]), "one");
    const request = structuredClone(setup.input.schemas[0]);
    request.schema.properties.flag = { type: "number", "x-weaver": { sensitive: true } };
    assert.equal((await schemas.register(request)).success, true);
    for (const read of [() => reader.get(["flag"]), () => reader.get(["flag"], { layer: "base" }),
      () => reader.get(["flag"], { defaultValue: "fallback" }), () => reader.withScope(setup.path1).get(["flag"]),
      () => port.get(["flag"])]) assert.throws(read, { code: "FORBIDDEN" });
    assert.equal(reader.inspect(["flag"]).effective.state, "redacted");
    assert.equal(reader.get().flag, undefined);
    const second = reader.withScope(setup.path2); await second.prepare();
    assert.throws(() => second.get(["flag"]), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("initial ownership conflicts, malformed input and callable readers reject before acquisition or IO", async () => {
  let closed = 0, getters = 0;
  const provider = new MemoryProvider("p", "base", {}), input = options([provider]);
  const host = readonlyHost(input);
  input.providers[0].ownership = { kind: "owned", dispose() { closed++; } };
  for (const registry of [{ initial: persisted([]) }, { initial: null }, { resolveAnchor() {} },
    { initial: { get environments() { getters++; return {}; } } }]) {
    await assert.rejects(createConfigurationService(input, { ...host, registry }), { code: "VALIDATION_ERROR" });
  }
  assert.equal(provider.loads + closed + getters, 0);
  const root = await createConfigurationService(input, { ...host, registry: { initial: undefined } });
  await root.dispose(); assert.equal(closed, 1);
});

test("schema invocation captures request/principal/options and CAS rechecks after awaited audit", async () => {
  const entered = deferred(), finish = deferred(); let audits = 0;
  const { root, controller, input } = await hosted(undefined, { audit: async (record) => {
    if (record.phase === "before-dispatch" && audits++ === 0) { entered.resolve(); await finish.promise; }
  } });
  const token = controller.mint(schemaClaims(input)), schemas = controller.forSchemas(token);
  try {
    const request = structuredClone(input.schemas[0]); request.schema.properties.added = { type: "boolean" };
    const options = { ifRevision: schemas.revision };
    const pending = schemas.register(request, options); await entered.promise;
    request.schema.properties.added.type = "string"; options.ifRevision = "changed";
    const second = schemas.register(input.schemas[0], { ifRevision: schemas.revision });
    finish.resolve(); assert.equal((await pending).success, true);
    assert.equal((await second).error.code, "REVISION_CONFLICT");
    assert.equal(schemas.get("/alpha", "east").detail.schema.properties.added.type, "boolean");
  } finally { finish.resolve(); await root.dispose(); }
});

test("data write queued behind registration uses the new privacy policy before any provider effect", async () => {
  const entered = deferred(), finish = deferred();
  const setup = await writable({ host: { hostAuthority: {
    authorizeReadSync: () => "allowed", async authorizeWrite(_, request) {
      if (request.operation === "schema-register") { entered.resolve(); await finish.promise; }
      return "allowed";
    },
  } } });
  try {
    const schemas = setup.controller.forSchemas(setup.controller.mint(schemaClaims(setup.input)));
    const request = structuredClone(setup.input.schemas[0]); request.schema.properties.flag["x-weaver"] = { sensitive: true };
    const registration = schemas.register(request); await entered.promise;
    const write = setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "never" }));
    finish.resolve(); assert.equal((await registration).success, true);
    assert.equal((await write).error.code, "FORBIDDEN"); assert.equal(setup.provider.writes, 0);
  } finally { finish.resolve(); await setup.root.dispose(); }
});
