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
    const identity = { environment: "test", scopePath: [] }, namespace = "/example";
    const options = { identity,
      schemas: [{ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { enabled: { type: "boolean" } } } }],
      layers: [{ kind: "fixed", layer: "base", providerIds: [provider.id] }, { kind: "session", layer: "incident" }],
      providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["test"] }, operation: { kind: "load" }, ownership: { kind: "borrowed" } }],
    };
    let controller;
    const host = {
      sessions: { defaultDurationMs: 60000, maxDurationMs: 60000, maxActiveSessions: 2 },
      authConfig: { weaverConfig: types.defineWeaver(options.layers.map((s) => types.Layers.Static(s.layer))), sessionLayer: "incident", elevatedSessionMode: "emergency-override", visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [{ layer: "incident", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
      hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" }, onAuthorityReady(value) { controller = value; },
    };
    const claims = { principalId: "host", roles: ["editor"], sessionPermissions: ["read", "activate", "extend", "deactivate"], grants: [{ identity, namespace, operations: ["read", "inspect", "write"], layers: ["base", "incident"], views: [], sensitive: false }] };
    let root = await service.createConfigurationService(options, host);
    try {
      const token = controller.mint(claims), sessions = controller.forSessions(token), reader = controller.forIdentity(token, { identity, namespace });
      assert.ok(types.configurationAuthorityControllerSchema.safeParse(controller).success);
      assert.ok(types.configurationSessionAuthoritySchema.safeParse(sessions).success);
      const created = await sessions.activate({ identity, namespace, reason: "packed", emergency: false });
      assert.equal(created.ok, true); assert.ok(types.configurationSessionInfoSchema.safeParse(created.value).success);
      const result = await controller.forMutations(token).apply([{ identity, namespace, layer: "incident", sessionId: created.value.id, operation: "set", path: "/example/enabled", value: false }]);
      assert.equal(result.success, true); assert.equal(reader.get(["enabled"]), false);
      assert.equal((await sessions.extend({ sessionId: created.value.id })).ok, true);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { example: { enabled: true } });
      await root.dispose();
      root = await service.createConfigurationService(options, host);
      const fresh = controller.mint(claims);
      assert.deepEqual(controller.forSessions(fresh).list(), []);
      assert.equal(controller.forIdentity(fresh, { identity, namespace }).get(["enabled"]), true);
      console.log(`packed ${format} native sessions: issued grants, metadata, sole apply, extension, real filesystem unchanged, fresh-root fallback`);
    } finally { await root.dispose(); provider.dispose(); }
  }
}
