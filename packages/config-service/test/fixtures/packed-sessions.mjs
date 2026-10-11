import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function packedSessions(directory) {
  const require = createRequire(join(directory, "package.json"));
  const types = require("@weaver-conf/config-types");
  for (const format of ["esm", "cjs"]) {
    const load = (name) => format === "cjs" ? require(name) : import(pathToFileURL(require.resolve(name).replace(/\.cjs$/, ".js")));
    const service = await load("@weaver-conf/config-service"), storage = await load("@weaver-conf/storage-providers");
    const path = join(directory, `${format}-sessions.json`);
    await writeFile(path, JSON.stringify({ example: { enabled: true } }));
    const provider = storage.createFileSystemStorageProvider({ id: "disk", layer: "base", filePath: path, writable: true });
    const upperPath = join(directory, `${format}-ceiling-upper.json`);
    await writeFile(upperPath, JSON.stringify({ example: { enabled: false } }));
    const upper = storage.createFileSystemStorageProvider({ id: "upper", layer: "upper", filePath: upperPath, writable: true });
    const identity = { environment: "test", scopePath: [] }, namespace = "/example";
    const options = { identity,
      schemas: [{ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { enabled: { type: "boolean", "x-weaver": { maxOverrideLayer: "base" } } } } }],
      layers: [{ kind: "fixed", layer: "base", providerIds: [provider.id] }, { kind: "fixed", layer: "upper", providerIds: [upper.id] }, { kind: "session", layer: "incident" }],
      providers: [provider, upper].map((provider) => ({ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["test"] }, operation: { kind: "load" }, ownership: { kind: "borrowed" } })),
    };
    let controller, wake, now = 1000;
    const host = {
      now: () => now,
      sessions: { defaultDurationMs: 60000, maxDurationMs: 60000, maxActiveSessions: 2,
        timer: { setTimeout(callback) { wake = callback; return 1; }, clearTimeout() { wake = undefined; } } },
      authConfig: { weaverConfig: types.defineWeaver(options.layers.map((s) => types.Layers.Static(s.layer))), sessionLayer: "incident", visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [{ layer: "incident", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
      hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" }, onAuthorityReady(value) { controller = value; },
    };
    const claims = { principalId: "host", roles: ["editor"], sessionPermissions: ["read", "activate", "extend", "deactivate", "emergency"], grants: [{ identity, namespace, operations: ["read", "inspect", "write"], layers: ["base", "upper", "incident"], views: [], sensitive: false }] };
    let root = await service.createConfigurationService(options, host);
    try {
      const token = controller.mint(claims), sessions = controller.forSessions(token), reader = controller.forIdentity(token, { identity, namespace });
      assert.equal(reader.get(["enabled"]), true);
      assert.equal(reader.get(["enabled"], { layer: "upper" }), false);
      assert.equal((await root.reloadProvider(upper.id)).ok, true);
      assert.equal(reader.inspect(["enabled"]).effectiveLayer, "base");
      assert.ok(types.configurationAuthorityControllerSchema.safeParse(controller).success);
      assert.ok(types.configurationSessionAuthoritySchema.safeParse(sessions).success);
      const ordinary = await sessions.activate({ identity, namespace, reason: "packed ordinary", emergency: false });
      assert.equal((await controller.forMutations(token).apply([{ identity, namespace, layer: "incident", sessionId: ordinary.value.id, operation: "set", path: "/example/enabled", value: false }])).error.code, "POLICY_VIOLATION");
      await sessions.deactivate({ sessionId: ordinary.value.id });
      const created = await sessions.activate({ identity, namespace, reason: "packed", emergency: true });
      assert.equal(created.ok, true); assert.ok(types.configurationSessionInfoSchema.safeParse(created.value).success);
      const result = await controller.forMutations(token).apply([{ identity, namespace, layer: "incident", sessionId: created.value.id, operation: "set", path: "/example/enabled", value: false }]);
      assert.equal(result.success, true); assert.equal(reader.get(["enabled"]), false);
      assert.equal((await sessions.extend({ sessionId: created.value.id })).ok, true);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { example: { enabled: true } });
      assert.deepEqual(JSON.parse(await readFile(upperPath, "utf8")), { example: { enabled: false } });
      now += 60001; wake(); await root.flush();
      assert.equal(reader.get(["enabled"]), true);
      assert.deepEqual(sessions.list(), []);
      await root.dispose();
      root = await service.createConfigurationService(options, host);
      const fresh = controller.mint(claims);
      assert.deepEqual(controller.forSessions(fresh).list(), []);
      assert.equal(controller.forIdentity(fresh, { identity, namespace }).get(["enabled"]), true);
      assert.equal(controller.forIdentity(fresh, { identity, namespace }).get(["enabled"], { layer: "upper" }), false);
      console.log(`packed ${format} native ceilings: standard denied, verified emergency, expiry, sole apply, extension, real filesystem unchanged, fresh-root fallback`);
    } finally { await root.dispose(); provider.dispose(); upper.dispose(); }
  }
}
