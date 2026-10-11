import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigurationService } from "../dist/index.js";
import { hosted, authConfig, principal, readonlyHost } from "./fixtures/authority.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";
import { deferred, registration, scopeOptions } from "./fixtures/memory.mjs";
import { WritableMemory, writableOptions, writer, writeBinding, commands } from "./fixtures/writable-memory.mjs";
import { withConsumer } from "./fixtures/packed-consumer.mjs";

async function storeSetup(extra = {}) {
  const provider = extra.provider ?? new WritableMemory();
  const input = writableOptions([provider]); input.schemas = [];
  const setup = await hosted(input, { registry: { storage: { kind: "provider", providerId: provider.id } },
    writers: [writer(provider, { flush: "required", ...extra.declaration })], ...extra.host });
  const token = setup.controller.mint(schemaClaims(input));
  const reader = setup.controller.forIdentity(setup.controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
  return { ...setup, reader, provider, token, schemas: setup.controller.forSchemas(token) };
}

test("captured writer stores metadata beside values and survives a later data write", async () => {
  const setup = await storeSetup(), { root, schemas, provider, controller, input } = setup;
  provider.flush = () => assert.fail("captured original flush must be used");
  try {
    assert.equal((await schemas.register(registration())).success, true);
    const claims = principal(input), mutations = controller.forMutations(controller.mint(claims));
    assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after" }))).success, true);
    assert.equal(provider.entries._weaver.registry.schemas.version, 2);
    assert.equal(provider.entries.alpha.flag, "after");
    const restarted = await hosted(input, { registry: { initial: provider.entries._weaver.registry.schemas }, });
     try {
       const reader = restarted.controller.forIdentity(restarted.controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
       assert.equal(reader.get(["flag"]), "after");
     }
    finally { await restarted.root.dispose(); }
    assert.throws(() => controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/_weaver/registry/schemas" }), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("required flush keeps old policy readable then atomically publishes sensitivity", async () => {
  const provider = new WritableMemory(), entered = deferred(), finish = deferred(); let delayed = false;
  provider.flush = async function () { this.flushes++; if (delayed) { entered.resolve(); await finish.promise; } };
  const { root, reader, schemas } = await storeSetup({ provider });
  try {
    assert.equal((await schemas.register(registration())).success, true);
    const revision = schemas.revision;
    delayed = true; const request = registration(); request.schema.properties.flag["x-weaver"] = { sensitive: true };
    const pending = schemas.register(request); await entered.promise;
    assert.equal(reader.get(["flag"]), "before"); assert.equal(schemas.revision, revision);
    finish.resolve(); assert.equal((await pending).success, true);
    assert.throws(() => reader.get(["flag"]), { code: "FORBIDDEN" });
    assert.notEqual(schemas.revision, revision);
  } finally { finish.resolve(); await root.dispose(); }
});

for (const kind of ["throw", "malformed", "false", "flush", "contradictory"]) {
  test(`uncertain schema ${kind} globally fences payloads with no readback`, async () => {
    const provider = new WritableMemory(); let fail = false;
    const original = provider.write;
    provider.write = async function (key, value) {
      const result = await original.call(this, key, value); if (!fail) return result;
      if (kind === "throw") throw Error("SECRET");
      if (kind === "malformed") return {};
      if (kind === "false") return { success: false };
      if (kind === "contradictory") return { success: true, error: { code: "WRITE_ERROR", message: "SECRET", timestamp: new Date().toISOString() } };
      return result;
    };
    provider.flush = async function () { this.flushes++; if (fail && kind === "flush") throw Error("SECRET"); };
    const { root, schemas, controller, input } = await storeSetup({ provider });
    try {
      assert.equal((await schemas.register(registration())).success, true);
      const token = controller.mint(principal(input)), mutations = controller.forMutations(token);
       const config = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
      const loads = provider.loads; fail = true;
      const request = registration(); request.schema.properties.flag["x-weaver"] = { sensitive: true };
      const result = await schemas.register(request);
      assert.equal(result.outcome, "unknown"); assert.equal(result.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.doesNotMatch(JSON.stringify(result), /SECRET/); assert.equal(result.revision, undefined);
      const reads = [() => config.get(["flag"]), () => config.get(["flag"], { layer: "base" }),
        () => config.get(["flag"], { defaultValue: "fallback" }), () => config.get(),
        () => config.withScope([]).get(["flag"]), () => config.inspect(["flag"]),
        () => config.snapshot(), () => config.validate(), () => schemas.snapshot(), () => schemas.list(), () => schemas.get("/alpha", "east")];
      for (const read of reads) assert.throws(read, { code: "SERVER_DEGRADED" });
      await assert.rejects(config.prepare(), { code: "SERVER_DEGRADED" });
      assert.equal((await schemas.register(request)).error.code, "WRITE_UNAVAILABLE");
      assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "x" }))).error.code, "WRITE_UNAVAILABLE");
      assert.equal(root.mode, "degraded"); assert.deepEqual(root.degradedProviders, [provider.id]);
      assert.equal(provider.loads, loads);
      controller.revoke(controller.mint(principal(input)));
      if (kind === "throw") {
        const recreated = await hosted(input, { registry: { initial: provider.entries._weaver.registry.schemas } });
        try {
          const reader = recreated.controller.forIdentity(recreated.controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
          assert.throws(() => reader.get(["flag"]), { code: "FORBIDDEN" });
        } finally { await recreated.root.dispose(); }
      }
    } finally { await root.dispose(); }
    assert.throws(() => schemas.snapshot(), { code: "DISPOSED" });
    assert.throws(() => root.mode, { code: "DISPOSED" });
  });
}

test("guaranteed no-effect rejection preserves metadata, cursors and all configuration revisions", async () => {
  const provider = new WritableMemory(); let fail = false; const original = provider.write;
  provider.write = function (key, value) { return fail ? Promise.resolve({ success: false }) : original.call(this, key, value); };
  const { root, reader, schemas } = await storeSetup({ provider, declaration: { failureSemantics: "rejected-means-no-effect" } });
  try {
    assert.equal((await schemas.register(registration())).success, true);
    assert.equal((await schemas.register(registration("east", "beta"))).success, true);
    const metadata = schemas.snapshot(), revision = reader.revision, page = schemas.list({ limit: 1 });
    fail = true; const result = await schemas.register(registration());
    assert.equal(result.outcome, "rejected"); assert.deepEqual(schemas.snapshot(), metadata);
    assert.equal(reader.revision, revision); assert.equal(root.mode, "live");
    assert.doesNotThrow(() => schemas.list({ cursor: page.page.nextCursor }));
  } finally { await root.dispose(); }
});

test("known schema commit survives post-dispatch revocation/disposal; cleanup waits flush", async () => {
  const provider = new WritableMemory(), entered = deferred(), finish = deferred(); let closed = 0;
  provider.flush = async () => { entered.resolve(); await finish.promise; };
  const input = writableOptions([provider]); input.schemas = [];
  input.providers[0].ownership = { kind: "owned", dispose() { closed++; } };
  const setup = await hosted(input, { registry: { storage: { kind: "provider", providerId: provider.id } }, writers: [writer(provider, { flush: "required" })] });
  const token = setup.controller.mint(schemaClaims(input)), schemas = setup.controller.forSchemas(token);
  const pending = schemas.register(registration()); await entered.promise;
  setup.controller.revoke(token); const disposal = setup.root.dispose(); assert.equal(closed, 0);
  finish.resolve(); assert.equal((await pending).success, true); await disposal; assert.equal(closed, 1);
  assert.equal(provider.entries._weaver.registry.schemas.version, 2);
});

test("provider-backed seed is durable before readiness; failed seed cleans ownership and never announces", async () => {
  for (const fail of [false, true]) {
    const provider = new WritableMemory(), input = writableOptions([provider]); let ready = 0, closed = 0, controller;
    input.providers[0].ownership = { kind: "owned", dispose() { closed++; } };
    if (fail) provider.flush = async () => { throw Error("SECRET"); };
    const host = { registry: { storage: { kind: "provider", providerId: provider.id } },
      writers: [writer(provider, { flush: "required" })], authConfig: authConfig(input),
      hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" },
      onAuthorityReady(value) { controller = value; ready++; assert.equal(provider.entries._weaver.registry.schemas.version, 2); } };
    if (fail) {
      await assert.rejects(createConfigurationService(input, host), { code: "WRITE_OUTCOME_UNKNOWN" });
      assert.equal(ready, 0); assert.equal(closed, 1);
    } else {
      const root = await createConfigurationService(input, host);
      assert.equal(ready, 1); assert.equal(provider.flushes, 1);
      const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
      assert.equal(reader.get(["flag"]), "before"); await root.dispose(); assert.equal(closed, 1);
    }
  }
});

test("selected storage without a writer browses but rejects registration; seeds reject before IO", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const host = { registry: { storage: { kind: "provider", providerId: provider.id } } };
  await assert.rejects(createConfigurationService(input, { ...readonlyHost(input), ...host }), { code: "WRITE_UNAVAILABLE" });
  assert.equal(provider.loads, 0); input.schemas = [];
  const { root, controller } = await hosted(input, host);
  try {
    const schemas = controller.forSchemas(controller.mint(schemaClaims(input)));
    assert.deepEqual(schemas.snapshot().anchors, []);
    assert.equal((await schemas.register(registration())).error.code, "WRITE_UNAVAILABLE");
    assert.equal(provider.writes + provider.flushes, 0);
  } finally { await root.dispose(); }
});

test("co-located fixed metadata feeds ready and future scoped views without erasing config values", async () => {
  const scope = scopeOptions(), provider = new WritableMemory("base", "base", scope.base.entries);
  scope.input.providers[0] = writeBinding(provider);
  const { root, controller } = await hosted(scope.input, {
    registry: { storage: { kind: "provider", providerId: provider.id } }, writers: [writer(provider)],
  });
  const claims = principal(scope.input);
  claims.grants.push(...[scope.path1, scope.path2].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  const reader = controller.forIdentity(controller.mint(claims), { identity: scope.input.identity, namespace: "/alpha" });
  try {
    await reader.withScope(scope.path1).prepare();
    const schemas = controller.forSchemas(controller.mint(schemaClaims(scope.input)));
    const request = structuredClone(scope.input.schemas[0]); request.schema.properties.flag["x-weaver"] = { sensitive: true };
    assert.equal((await schemas.register(request)).success, true);
    const metadata = structuredClone(provider.entries._weaver.registry.schemas);
    const mutations = controller.forMutations(controller.mint(principal(scope.input)));
    assert.equal((await mutations.apply(commands(scope.input, { operation: "set", path: "/alpha/cfg/b", value: 42 }))).success, true);
    await reader.withScope(scope.path2).prepare();
    for (const path of [scope.path1, scope.path2]) {
      assert.throws(() => reader.withScope(path).get(["flag"]), { code: "FORBIDDEN" });
      assert.equal(reader.withScope(path).get(["cfg", "b"]), 42);
    }
    assert.deepEqual(provider.entries._weaver.registry.schemas, metadata);
    assert.equal(provider.entries.alpha.flag, "base");
    assert.equal(reader.get().flag, undefined);
  } finally { await root.dispose(); }
});

test("schema audit failures remain fail-open with value-free discriminated records", async () => {
  const records = [];
  const { root, schemas } = await storeSetup({ host: { audit(record) { records.push(record); throw Error("SECRET"); } } });
  try {
    const request = registration(); request.schema.properties.flag.default = "PRIVATE-DEFAULT";
    assert.equal((await schemas.register(request)).success, true);
    assert.deepEqual(records.map((record) => record.phase), ["before-dispatch", "committed"]);
    assert.ok(records.every((record) => record.request.operation === "schema-register"));
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE-DEFAULT|SECRET/);
    assert.equal(schemas.get("/alpha", "east").detail.schema.properties.flag.default, "PRIVATE-DEFAULT");
  } finally { await root.dispose(); }
});

test("packed ESM/CJS real filesystem ordinary and mapped registry restart shares data and codecs", async () => {
  await withConsumer(async (directory) => {
    const require = createRequire(join(directory, "package.json"));
    const storage = require("@weaver-conf/storage-providers");
    for (const cjs of [false, true]) for (const mapped of [false, true]) {
      const service = cjs ? require("@weaver-conf/config-service") : await import(pathToFileURL(require.resolve("@weaver-conf/config-service").replace(/\.cjs$/, ".js")));
      const codec = cjs ? require("@weaver-conf/config-registry/persistence") : await import(pathToFileURL(require.resolve("@weaver-conf/config-registry/persistence").replace(/\.cjs$/, ".js")));
      const folder = await mkdtemp(join(tmpdir(), "weaver-live-registry-"));
      const provider = storage.createFileSystemStorageProvider({ id: "disk", layer: "base", filePath: join(folder, "data.json"), writable: true });
      const dialect = "actual:雪", input = writableOptions([provider]); input.schemas = [];
      input.providers[0].operation = mapped ? { kind: "load-layer", layer: dialect } : { kind: "load" };
      const declaration = writer(provider, { operation: mapped ? { kind: "write-layer", layer: dialect } : { kind: "write" } });
      let root;
      try {
        for (const restart of [false, true]) {
          const raw = mapped ? await provider.loadLayer(dialect) : await provider.load();
          let controller;
          root = await service.createConfigurationService(input, { registry: {
            initial: restart && cjs ? { environments: raw.entries._weaver.registry.schemas.environments } : raw.entries._weaver?.registry?.schemas,
            storage: { kind: "provider", providerId: provider.id } },
            authConfig: authConfig(input), writers: [declaration], hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" },
            onAuthorityReady(value) { controller = value; } });
          const schemas = controller.forSchemas(controller.mint(schemaClaims(input)));
          if (!restart) {
            const request = registration(); request.fragmentSlots = [{ slotPath: "/plugins", accepts: "object" }];
            assert.equal((await schemas.register(request)).success, true);
            assert.equal((await schemas.register({ serviceId: "alpha", providerId: "plugin", slotPath: "/plugins", environment: "east",
              owner: request.owner, schema: { type: "object", properties: { enabled: { type: "boolean" } } } })).success, true);
            const mutations = controller.forMutations(controller.mint(principal(input)));
            assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "durable" }))).success, true);
          } else {
            const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
            assert.equal(reader.get(["flag"]), "durable");
            assert.equal(schemas.get("/alpha", "east").detail.schema.type, "object");
            assert.equal(codec.parsePersistedRegistry(raw.entries._weaver.registry.schemas).schemas.size, 2);
            assert.equal(schemas.snapshot().slots.length, 1);
            assert.equal(schemas.get("/alpha/plugins/plugin", "east").detail.kind, "fragment");
          }
          await root.dispose(); root = undefined;
        }
      } finally { await root?.dispose(); provider.dispose(); await rm(folder, { recursive: true, force: true }); }
    }
  });
});
