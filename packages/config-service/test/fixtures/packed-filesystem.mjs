import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function filesystemProof(directory) {
  const require = createRequire(join(directory, "package.json"));
  for (const format of ["esm", "cjs"]) {
    const service = format === "esm" ? await import(pathToFileURL(require.resolve("@weaver-conf/config-service").replace(/\.cjs$/, ".js"))) : require("@weaver-conf/config-service");
    const storage = format === "esm" ? await import(pathToFileURL(require.resolve("@weaver-conf/storage-providers").replace(/\.cjs$/, ".js"))) : require("@weaver-conf/storage-providers");
    assert.deepEqual(Object.keys(service), ["configurationServiceHostOptionsSchema", "createConfigurationService"]);
    const filePath = join(directory, `${format}-base.json`), overlay = join(directory, `${format}-overlay.json`);
    await writeFile(filePath, JSON.stringify({ example: { a: 1, b: 2 } }));
    await writeFile(`${filePath}.${encodeURIComponent("mapped:layer")}.json`, JSON.stringify({ example: { a: 9, b: 3 } }));
    await writeFile(overlay, JSON.stringify({ example: { a: 5 } }));
    const provider = storage.createFileSystemStorageProvider({ id: "filesystem", layer: "files", filePath, environmentOverlayPath: overlay, writable: true });
    let owned = 0;
    const input = { identity: { environment: "mapped", scopePath: [] }, schemas: [{ serviceId: "example", environment: "mapped", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }], layers: [{ kind: "fixed", layer: "files", providerIds: ["filesystem"] }], providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["mapped"] }, operation: { kind: "load-layer", layer: "mapped:layer" }, ownership: { kind: "owned", dispose: () => { owned++; } } }] };
    let root = await service.createConfigurationService(input);
    try {
      assert.equal(root.get("/example/a"), 5); assert.equal(root.getAtLayer("files", "/example/b"), 3); assert.equal(root.inspect("/example/b").effectiveLayer, "files");
    } finally { await root.dispose(); }
    await root.dispose(); assert.equal(owned, 1);
    input.providers[0].ownership = { kind: "borrowed" }; input.providers[0].operation = { kind: "load" };
    root = await service.createConfigurationService(input);
    try { assert.equal(root.get("/example/b"), 2); }
    finally { await root.dispose(); }
    assert.equal(owned, 1);
    console.log(`real packed ${format} filesystem load/loadLayer+overlay, synchronous projection/inspection, owned once/borrowed untouched`);
    const types = require("@weaver-conf/config-types");
    for (const dialect of ["write", "write-layer"]) await filesystemWrites(service, storage, types, directory, format, dialect);
  }
}

async function filesystemWrites(service, storage, types, directory, format, dialect) {
  const filePath = join(directory, `${format}-${dialect}-writes.json`), layer = "mapped:日本";
  const provider = storage.createFileSystemStorageProvider({ id: "writer", layer: "files", filePath, writable: true });
  const identity = { environment: "mapped", scopePath: [] };
  const input = { identity, schemas: [{ serviceId: "example", environment: "mapped", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { "literal.dot": { type: "string" }, "雪": { type: "null" } } } }],
    layers: [{ kind: "fixed", layer: "files", providerIds: [provider.id] }], providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["mapped"] }, operation: dialect === "write" ? { kind: "load" } : { kind: "load-layer", layer }, ownership: { kind: "borrowed" } }] };
  let controller;
  const host = { authConfig: { weaverConfig: types.defineWeaver([types.Layers.Static("files")]), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [{ layer: "files", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" },
    writers: [{ providerId: provider.id, operation: dialect === "write" ? { kind: "write" } : { kind: "write-layer", layer }, flush: "none", failureSemantics: "unknown" }], onAuthorityReady(value) { controller = value; } };
  let root = await service.createConfigurationService(input, host);
  const bind = () => controller.bindRoot(controller.mint({ principalId: "verified", roles: ["editor"], grants: [{ identity, namespace: "/example", operations: ["read", "inspect", "write"], layers: ["files"], views: [], sensitive: false }] }));
  try {
    bind(); const before = root.revision;
    assert.equal((await root.set("/example/literal.dot", "persisted", { layer: "files", ifRevision: before })).success, true);
    assert.equal((await root.set("/example/雪", null, { layer: "files" })).success, true);
    assert.equal(root.get("/example/literal.dot"), "persisted"); assert.equal(root.get("/example/雪"), null);
  } finally { await root.dispose(); }
  root = await service.createConfigurationService(input, host);
  try {
    bind(); assert.equal(root.get("/example/literal.dot"), "persisted"); assert.equal(root.get("/example/雪"), null);
    assert.equal((await root.remove("/example/literal.dot", { layer: "files" })).success, true);
  } finally { await root.dispose(); }
  root = await service.createConfigurationService(input, host);
  try { bind(); assert.equal(root.get("/example/literal.dot"), undefined); assert.equal(root.get("/example/雪"), null); }
  finally { await root.dispose(); provider.dispose(); }
  console.log(`real packed ${format} filesystem governed ${dialect} literal-dot/null/Unicode, persisted root recreation and remove`);
}
