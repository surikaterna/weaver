import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, writeFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";

export async function filesystemProof(directory) {
  const require = createRequire(join(directory, "package.json"));
  for (const format of ["esm", "cjs"]) {
    const service = format === "esm" ? await import(pathToFileURL(require.resolve("@weaver-conf/config-service").replace(/\.cjs$/, ".js"))) : require("@weaver-conf/config-service");
    const storage = format === "esm" ? await import(pathToFileURL(require.resolve("@weaver-conf/storage-providers").replace(/\.cjs$/, ".js"))) : require("@weaver-conf/storage-providers");
    assert.deepEqual(Object.keys(service), ["configurationServiceHostBindingSchema", "configurationServiceHostOptionsSchema", "createConfigurationService"]);
    const types = require("@weaver-conf/config-types");
    const filePath = join(directory, `${format}-base.json`), overlay = join(directory, `${format}-overlay.json`);
    await writeFile(filePath, JSON.stringify({ example: { a: 1, b: 2 } }));
    await writeFile(`${filePath}.${encodeURIComponent("mapped:layer")}.json`, JSON.stringify({ example: { a: 9, b: 3 } }));
    await writeFile(overlay, JSON.stringify({ example: { a: 5 } }));
    const provider = storage.createFileSystemStorageProvider({ id: "filesystem", layer: "files", filePath, environmentOverlayPath: overlay, writable: true });
    let owned = 0;
    const input = { identity: { environment: "mapped", scopePath: [] }, schemas: [{ serviceId: "example", environment: "mapped", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }], layers: [{ kind: "fixed", layer: "files", providerIds: ["filesystem"] }], providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["mapped"] }, operation: { kind: "load-layer", layer: "mapped:layer" }, ownership: { kind: "owned", dispose: () => { owned++; } } }] };
    let { root, reader } = await openPublicReader(service, types, input);
    try {
      assert.equal(reader.get(["a"]), 5); assert.equal(reader.get(["b"], { layer: "files" }), 3); assert.equal(reader.inspect(["b"]).effectiveLayer, "files");
    } finally { await root.dispose(); }
    await root.dispose(); assert.equal(owned, 1);
    input.providers[0].ownership = { kind: "borrowed" }; input.providers[0].operation = { kind: "load" };
    ({ root, reader } = await openPublicReader(service, types, input));
    try { assert.equal(reader.get(["b"]), 2); }
    finally { await root.dispose(); }
    assert.equal(owned, 1);
    console.log(`real packed ${format} filesystem load/loadLayer+overlay, synchronous projection/inspection, owned once/borrowed untouched`);
    for (const dialect of ["write", "write-layer"]) await filesystemWrites(service, storage, types, directory, format, dialect);
    await filesystemWatch(service, storage, types, directory, format);
  }
}

// Same native acquisition evidence used by storage-providers' Node 26 regression suite.
async function until(predicate, description) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, description);
    await sleep(5);
  }
}

async function filesystemWatch(service, storage, types, directory, format) {
  const filePath = join(directory, `${format}-watch.json`);
  await writeFile(filePath, JSON.stringify({ example: { flag: "initial" } }));
  const provider = storage.createFileSystemStorageProvider({ id: "watched", layer: "files", filePath, writable: false, watchDebounceMs: 5 });
  const count = () => process.getActiveResourcesInfo().filter(name => name === "FSEventWrap").length;
  const before = count();
  const input = { identity: { environment: "mapped", scopePath: [] },
    schemas: [{ serviceId: "example", environment: "mapped", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [],
      schema: { type: "object", properties: { flag: { type: "string", "x-weaver": { reloadBehavior: "rolling-restart" } } } } }],
    layers: [{ kind: "fixed", layer: "files", providerIds: [provider.id] }],
    providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" }, watch: true }] };
  const { root, reader } = await openPublicReader(service, types, input);
  const events = [];
  try {
    reader.onChange(["flag"], event => events.push(event));
    await until(() => count() > before, "native FS watcher acquired before external edit");
    await writeFile(filePath, JSON.stringify({ example: { flag: "external" } }));
    await until(() => events.length === 1, "one external edit publication");
    assert.equal(events[0].cause, "external"); assert.equal(events[0].current.value, "external");
    assert.equal(types.configurationReaderChangeSchema.safeParse(events[0]).success, true);
    assert.equal(reader.get(["flag"]), "external"); assert.equal(root.restartState.pending, "rolling-restart");
    assert.equal((await root.acknowledgeRestart(root.restartState.revision)).ok, true);
    assert.equal((await root.flush()).ok, true);
    await rm(filePath);
    await until(() => events.length === 2, "external removal publication");
    assert.deepEqual(events[1].current, { state: "missing" });
    assert.equal((await root.reloadProvider(provider.id)).ok, true);
    assert.equal(events.length, 2);
  } finally { await root.dispose(); provider.dispose(); }
  await until(() => count() === before, "root releases its native watch");
  console.log(`real packed ${format} read-only filesystem watch edit/remove, reload, event schema, flush and restart acknowledgement`);
}

async function openPublicReader(service, types, input) {
  let reader;
  const root = await service.createConfigurationService(input, {
    authConfig: { weaverConfig: types.defineWeaver(input.layers.map(({ layer }) => types.Layers.Static(layer))), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "denied" },
    onAuthorityReady(controller) {
      const token = controller.mint({ principalId: "public-reader", roles: [], grants: [{ identity: input.identity, namespace: "/example", operations: ["read", "inspect"], layers: input.layers.map(({ layer }) => layer), views: [], sensitive: false }] });
      reader = controller.forIdentity(token, { identity: input.identity, namespace: "/example" });
    },
  });
  return { root, reader };
}

async function filesystemWrites(service, storage, types, directory, format, dialect) {
  const filePath = join(directory, `${format}-${dialect}-writes.json`), layer = "mapped:日本";
  const provider = storage.createFileSystemStorageProvider({ id: "writer", layer: "files", filePath, writable: true });
  const identity = { environment: "mapped", scopePath: [] };
  const input = { identity, schemas: [{ serviceId: "example", environment: "mapped", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { "literal.dot": { type: "string" }, "雪": { type: "null" }, cfg: { type: "object", additionalProperties: true }, list: { type: "array", items: { type: ["number", "null"] } }, instances: { type: "object", additionalProperties: { type: "object", properties: { "literal.dot": { type: "string" } } } } } } }],
    layers: [{ kind: "fixed", layer: "files", providerIds: [provider.id] }], providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["mapped"] }, operation: dialect === "write" ? { kind: "load" } : { kind: "load-layer", layer }, ownership: { kind: "borrowed" } }] };
  let controller, release, enter, wait = true, flushes = 0;
  const entered = new Promise((resolve) => { enter = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  provider.flush = async () => { flushes++; if (wait) { enter(); await gate; } };
  const host = { authConfig: { weaverConfig: types.defineWeaver([types.Layers.Static("files")]), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [{ layer: "files", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" },
    writers: [{ providerId: provider.id, operation: dialect === "write" ? { kind: "write" } : { kind: "write-layer", layer }, flush: "required", failureSemantics: "unknown" }], onAuthorityReady(value) { controller = value; } };
  let root = await service.createConfigurationService(input, host);
  const issue = () => {
    const grant = { identity, namespace: "/example", operations: ["read", "inspect", "write"], layers: ["files"], views: [], sensitive: false };
    const token = controller.mint({ principalId: "verified", roles: ["editor"], grants: [grant, { ...grant, views: ["one"] }] });
    return { reader: controller.forIdentity(token, { identity, namespace: "/example" }), mutations: controller.forMutations(token) };
  };
  const selection = { identity, namespace: "/example", layer: "files" };
  try {
    const { reader, mutations } = issue(), before = reader.revision;
    const pending = mutations.apply([{ ...selection, operation: "set", path: "/example/literal.dot", value: "persisted", ifRevision: before }, { ...selection, operation: "set", path: "/example/雪", value: null, ifRevision: before }]);
    await entered;
    assert.equal(reader.get(["literal.dot"]), undefined); assert.equal(reader.revision, before);
    const selected = dialect === "write" ? filePath : `${filePath}.${encodeURIComponent(layer)}.json`;
    assert.equal(JSON.parse(await readFile(selected, "utf8")).example["literal.dot"], "persisted");
    wait = false; release(); assert.equal((await pending).success, true); assert.equal(flushes, 1);
    assert.equal(reader.get(["literal.dot"]), "persisted"); assert.equal(reader.get(["雪"]), null);
    assert.equal((await mutations.apply([
      { ...selection, operation: "set", path: "/example/cfg", value: { "parent.namespace": { "雪": null } } },
      { ...selection, operation: "set", path: "/example/list", value: [1] },
      { ...selection, operation: "patch", path: "/example/list/1", value: null },
    ])).success, true);
    const view = reader.forView("one"); await view.prepare();
    assert.equal(view.get(["literal.dot"]), "persisted");
    assert.equal((await mutations.apply([{ ...selection, operation: "set", viewId: "one", path: "/example/literal.dot", value: "override" }])).success, true);
    assert.equal(view.get(["literal.dot"]), "override");
    assert.equal(reader.get(["literal.dot"]), "persisted");
    assert.equal(JSON.parse(await readFile(selected, "utf8")).example.instances.one["literal.dot"], "override");
  } finally { release(); await root.dispose(); }
  root = await service.createConfigurationService(input, host);
  try {
    const { reader, mutations } = issue(); assert.equal(reader.get(["literal.dot"]), "persisted"); assert.equal(reader.get(["雪"]), null);
    assert.deepEqual(reader.get(["cfg"]), { "parent.namespace": { "雪": null } }); assert.deepEqual(reader.get(["list"]), [1, null]);
    const view = reader.forView("one"); await view.prepare();
    assert.equal(view.get(["literal.dot"]), "override");
    assert.equal(view.inspect(["literal.dot"]).effectiveSource, "view");
    assert.equal((await mutations.apply([{ ...selection, operation: "remove", viewId: "one", path: "/example" }])).success, true);
    assert.equal(view.get(["literal.dot"]), "persisted");
    assert.equal((await mutations.apply([{ ...selection, operation: "remove", path: "/example/literal.dot" }])).success, true);
  } finally { await root.dispose(); }
  root = await service.createConfigurationService(input, host);
  try { const { reader } = issue(); assert.equal(reader.get(["literal.dot"]), undefined); assert.equal(reader.get(["雪"]), null); const view = reader.forView("one"); await view.prepare(); assert.equal(view.get(["literal.dot"]), undefined); }
  finally { await root.dispose(); provider.dispose(); }
  console.log(`real packed ${format} filesystem governed ${dialect} literal-dot/null/Unicode, persisted root recreation and remove`);
}
