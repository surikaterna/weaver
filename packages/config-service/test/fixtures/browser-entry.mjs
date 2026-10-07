import * as service from "@weaver-conf/config-service";
import * as admission from "@weaver-conf/config-service/admission";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";
import { createCanonicalSchemaRegistry } from "@weaver-conf/config-registry";
import { defineWeaver, Layers, configurationMutationCommandsSchema, configurationMutationResultSchema } from "@weaver-conf/config-types";

export const exports = Object.keys(service);
export const admissionExports = Object.keys(admission);
export async function exercise() {
  let reader;
  const identity = { environment: "test", scopePath: [] };
  const provider = { id: "memory", layer: "base", writable: true,
    async load() { return { entries: { example: { cfg: { a: 1, b: 2 }, unknown: "PRIVATE", hidden: "SECRET" } } }; },
    async write() { throw Error("unexpected write"); }, async remove() { throw Error("unexpected remove"); } };
  const later = { ...provider, id: "later", layer: "later", async load() { return { entries: { example: { cfg: { a: 1, c: 3 } } } }; } };
  const root = await service.createConfigurationService({ identity: { environment: "test", scopePath: [] }, schemas: [{ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { cfg: { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } } }, hidden: { type: "string", "x-weaver": { sensitive: true } } } } }],
    layers: [{ kind: "fixed", layer: "base", providerIds: ["memory"] }, { kind: "fixed", layer: "later", providerIds: ["later"] }],
    providers: [provider, later].map((provider) => ({ id: provider.id, layer: provider.layer, provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" } })) }, {
    authConfig: { weaverConfig: defineWeaver([Layers.Static("base"), Layers.Static("later")]), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "denied" },
    onAuthorityReady(controller) { const token = controller.mint({ principalId: "public", roles: [], grants: [{ identity, namespace: "/example", operations: ["read", "inspect"], layers: ["base", "later"], views: [], sensitive: false }] }); reader = controller.forIdentity(token, { identity, namespace: "/example" }); },
  });
  try {
    const inspection = reader.inspect(["cfg", "a"]);
    if (reader.get(["cfg", "b"]) !== 2 || inspection.effectiveLayer !== "later" || reader.inspect(["cfg"]).effectiveLayer !== undefined) throw Error("provenance mismatch");
    if (/PRIVATE|SECRET/.test(JSON.stringify(reader.get()))) throw Error("projection leak");
    return { revision: reader.revision, winner: inspection.effectiveLayer, synchronous: typeof reader.get(["cfg", "a"]) === "number" };
  } finally { await root.dispose(); }
}

export async function exerciseWrites() {
  await exerciseSessions();
  await exercisePublication();
  await exerciseHost();
  exerciseMutationPreparation();
  const entries = { example: { enabled: true, hidden: "PRIVATE" } };
  let controller, writes = 0, removes = 0, flushes = 0;
  const provider = { id: "writable", layer: "selected", writable: true,
    async load() { return { entries: structuredClone(entries) }; },
    async write(key, value) { writes++; if (value === "known-stop") return { success: false }; deepSet(entries, key, value); return { success: true }; },
    async remove(key) { removes++; deepRemove(entries, key); return { success: true }; },
    async flush() { flushes++; } };
  const identity = { environment: "test", scopePath: [] }, registry = createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
  const request = { serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { enabled: { type: "boolean" }, hidden: { type: "string", "x-weaver": { sensitive: true } } } } };
  const registered = registry.register(request);
  if (!registered.success) throw Error("registration failed");
  const prepared = admission.prepareConfigMutation({ registry, environment: "test", layerBefore: entries, effectiveAfter: (value) => value, mutations: [{ key: "example.enabled", operation: "set", value: false }] });
  if (!prepared.success || prepared.layerAfter.example.enabled !== false) throw Error("shared admission failed");
  const root = await service.createConfigurationService({ identity, schemas: [request], layers: [{ kind: "fixed", layer: "selected", providerIds: [provider.id] }],
    providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["test"] }, operation: { kind: "load" }, ownership: { kind: "borrowed" } }] }, {
    authConfig: { weaverConfig: defineWeaver([Layers.Static("selected")]), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [{ layer: "selected", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
    writers: [{ providerId: provider.id, operation: { kind: "write" }, flush: "required", failureSemantics: "rejected-means-no-effect" }],
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" }, onAuthorityReady(value) { controller = value; },
  });
  try {
    const grant = { identity, namespace: "/example", operations: ["read", "inspect", "write"], layers: ["selected"], views: [], sensitive: false };
    const token = controller.mint({ principalId: "verified-writer", roles: ["editor"], grants: [grant, { ...grant, views: ["one"] }] });
    const port = controller.forIdentity(token, { identity, namespace: "/example" });
    const mutations = controller.forMutations(token), selection = { identity, namespace: "/example", layer: "selected" };
    if (!(await mutations.apply([{ ...selection, operation: "set", path: "/example/enabled", value: false, ifRevision: port.revision }])).success || port.get(["enabled"]) !== false || entries.example.enabled !== false) throw Error("write publication failed");
    if ((await mutations.apply([{ ...selection, operation: "set", path: "/example/hidden", value: "exposed" }])).success) throw Error("private write allowed");
    if (!(await mutations.apply([{ ...selection, operation: "remove", path: "/example/enabled" }])).success || port.get(["enabled"]) !== undefined || "enabled" in entries.example) throw Error("remove failed");
    if (writes !== 1 || removes !== 1 || flushes !== 2) throw Error("wrong provider effects");
    const schemaToken = controller.mint({ principalId: "schema-admin", roles: [], schemaPermissions: ["read", "register"],
      grants: [{ identity, namespace: "/example", operations: [], layers: [], views: [], sensitive: false }] });
    const schemas = controller.forSchemas(schemaToken), revision = schemas.revision;
    if (!(await schemas.register(request, { ifRevision: revision })).success || schemas.revision === revision) throw Error("live registry failed");
    if (schemas.snapshot().anchors.length !== 1 || schemas.list({ limit: 1 }).page.anchors.length !== 1 || !schemas.get("/example", "test").detail) throw Error("schema catalog failed");
    const publicRequest = structuredClone(request);
    delete publicRequest.schema.properties.hidden["x-weaver"];
    publicRequest.schema.properties.cfg = { type: "object", additionalProperties: true };
    publicRequest.schema.properties.list = { type: "array", items: { type: ["number", "null"] } };
    publicRequest.schema.properties.instances = { type: "object", additionalProperties: { type: "object", properties: { enabled: { type: "boolean" } } } };
    if (!(await schemas.register(publicRequest)).success || !port.validate().validation.valid) throw Error("raw validation query failed");
    await exerciseBatch(mutations, selection, port);
    if (writes !== 7 || removes !== 1 || flushes !== 4) throw Error("batch effects/flush grouping mismatch");
    const view = port.forView("one"); await view.prepare();
    if (!(await mutations.apply([{ ...selection, operation: "set", viewId: "one", path: "/example/enabled", value: false }])).success || view.get(["enabled"]) !== false || port.get(["enabled"]) !== undefined) throw Error("view isolation failed");
    if (view.inspect(["enabled"]).effectiveSource !== "view") throw Error("view provenance failed");
    if (!(await mutations.apply([{ ...selection, operation: "remove", viewId: "one", path: "/example" }])).success || view.get(["enabled"]) !== undefined) throw Error("view reset failed");
    controller.revoke(schemaToken);
    let denied = false; try { schemas.snapshot(); } catch (error) { denied = error.code === "FORBIDDEN"; }
    if (!denied) throw Error("revoked schema token exposed metadata");
  } finally { await root.dispose(); }
}

async function exerciseSessions() {
  let controller;
  const identity = { environment: "test", scopePath: [] };
  const provider = { id: "base", layer: "base", writable: false,
    async load() { return { entries: { example: { enabled: true } } }; },
    async write() { throw Error("unexpected storage write"); }, async remove() { throw Error("unexpected storage remove"); } };
  const root = await service.createConfigurationService({ identity,
    schemas: [{ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { enabled: { type: "boolean" } } } }],
    layers: [{ kind: "fixed", layer: "base", providerIds: [provider.id] }, { kind: "session", layer: "incident" }],
    providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" } }],
  }, {
    sessions: { defaultDurationMs: 60000, maxDurationMs: 60000, maxActiveSessions: 2 },
    authConfig: { weaverConfig: defineWeaver([Layers.Static("base"), Layers.Static("incident")]), sessionLayer: "incident", elevatedSessionMode: "emergency-override", visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [{ layer: "incident", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" }, onAuthorityReady(value) { controller = value; },
  });
  try {
    const token = controller.mint({ principalId: "verified", roles: ["editor"], sessionPermissions: ["read", "activate", "extend", "deactivate"], grants: [{ identity, namespace: "/example", operations: ["read", "inspect", "write"], layers: ["base", "incident"], views: [], sensitive: false }] });
    const sessions = controller.forSessions(token), reader = controller.forIdentity(token, { identity, namespace: "/example" });
    const activated = await sessions.activate({ identity, namespace: "/example", reason: "browser", emergency: false });
    if (!activated.ok || sessions.list().length !== 1) throw Error("session activation failed");
    const result = await controller.forMutations(token).apply([{ identity, namespace: "/example", layer: "incident", sessionId: activated.value.id, operation: "set", path: "/example/enabled", value: false }]);
    if (!result.success || reader.get(["enabled"]) !== false) throw Error("session apply failed");
    if (!(await sessions.extend({ sessionId: activated.value.id })).ok) throw Error("session extension failed");
    if (!(await sessions.deactivate({ sessionId: activated.value.id })).ok || reader.get(["enabled"]) !== true) throw Error("session fallback failed");
  } finally { await root.dispose(); }
}

async function exercisePublication() {
  let controller, notify, released = 0;
  const entries = { example: { enabled: true } }, identity = { environment: "test", scopePath: [] };
  const provider = { id: "live", layer: "base", writable: false,
    async load() { return { entries: structuredClone(entries) }; },
    async write() { throw Error("read-only"); }, async remove() { throw Error("read-only"); },
    onExternalChange(callback) { notify = callback; return () => { released++; }; } };
  const root = await service.createConfigurationService({ identity,
    schemas: [{ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [],
      schema: { type: "object", properties: { enabled: { type: "boolean", "x-weaver": { reloadBehavior: "restart-required" } } } } }],
    layers: [{ kind: "fixed", layer: "base", providerIds: [provider.id] }],
    providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" }, watch: true }] }, {
    authConfig: { weaverConfig: defineWeaver([Layers.Static("base")]), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "denied" }, onAuthorityReady(value) { controller = value; },
  });
  try {
    const token = controller.mint({ principalId: "reader", roles: [], grants: [{ identity, namespace: "/example", operations: ["read", "inspect"], layers: ["base"], views: [], sensitive: false }] });
    const reader = controller.forIdentity(token, { identity, namespace: "/example" });
    const event = new Promise(resolve => reader.onChange(["enabled"], resolve));
    entries.example.enabled = false; notify([]);
    const changed = await event;
    if (changed.kind !== "effective" || changed.current.value !== false || changed.cause !== "external") throw Error("watch publication failed");
    if (root.restartState.pending !== "restart-required") throw Error("missing restart latch");
    if (!(await root.acknowledgeRestart(root.restartState.revision)).ok || root.restartState.pending !== "none") throw Error("acknowledgement failed");
    if (!(await root.flush()).ok || !(await root.reloadProvider(provider.id)).ok) throw Error("host lifecycle failed");
  } finally { await root.dispose(); }
  if (released !== 1) throw Error("watch ownership failed");
}

async function exerciseBatch(mutations, selection, query) {
  const result = await mutations.apply([
    { ...selection, operation: "set", path: "/example/cfg", value: { a: 1 } },
    { ...selection, operation: "patch", path: "/example/cfg/a", value: 2 },
    { ...selection, operation: "set", path: "/example/list", value: [1] },
    { ...selection, operation: "patch", path: "/example/list/1", value: null },
  ]);
  if (!result.success || !configurationMutationResultSchema.safeParse(result).success || query.get(["cfg", "a"]) !== 2 || query.get(["list", "1"]) !== null) throw Error("browser canonical batch failed");
  const partial = await mutations.apply(["first", "known-stop", "never"].map((value) => ({ ...selection, operation: "set", path: "/example/hidden", value })));
  if (partial.outcome !== "partial" || !configurationMutationResultSchema.safeParse(partial).success || query.get(["hidden"]) !== "first") throw Error("browser prefix publication failed");
}

function exerciseMutationPreparation() {
  const identity = { environment: "test", scopePath: [] };
  const input = [{ operation: "patch", identity, namespace: "/example", layer: "selected", path: "/example/list/0", value: null }];
  const commands = configurationMutationCommandsSchema.parse(input);
  input[0].value = "changed";
  if (commands[0].value !== null || !Object.isFrozen(commands)) throw Error("mutation capture failed");
  const schema = { type: "object", properties: { list: { type: "array", items: { type: ["string", "null"] } } } };
  const patch = admission.buildSchemaPatch({ list: [] }, ["list", "0"], commands[0].value, schema);
  if (!patch.success || patch.value.list[0] !== null || !admission.schemaPatchResultSchema.safeParse(patch).success) throw Error("native patch preparation failed");
  const error = { code: "WRITE_ERROR", message: "stopped" };
  if (!configurationMutationResultSchema.safeParse({ success: false, outcome: "partial", error,
    results: [{ index: 0, effect: "committed" }, { index: 1, effect: "rejected", error }],
    revisions: [{ identity, revision: "prepared-contract" }] }).success) throw Error("native partial contract failed");
}

async function exerciseHost() {
  let controller, loads = 0, writes = 0;
  const provider = { id: "hosted", layer: "selected", writable: true,
    async load() { loads++; return { entries: { example: { enabled: true, hidden: "PRIVATE" } } }; },
    async write() { writes++; return { success: true }; }, async remove() { writes++; return { success: true }; } };
  const identity = { environment: "test", scopePath: [] };
  const options = { identity, schemas: [{ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { enabled: { type: "boolean" }, hidden: { type: "string", "x-weaver": { sensitive: true } } } } }],
    layers: [{ kind: "fixed", layer: "selected", providerIds: [provider.id] }],
    providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" } }] };
  const host = { authConfig: { weaverConfig: defineWeaver([Layers.Static("selected")]), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() { throw Error("unexpected host write authorization"); } },
    onAuthorityReady(value) { controller = value; } };
  if (!service.configurationServiceHostOptionsSchema.safeParse(host).success) throw Error("host schema mismatch");
  const root = await service.createConfigurationService(options, host);
  try {
    const token = controller.mint({ principalId: "trusted-host", roles: [], grants: [{ identity, namespace: "/example", operations: ["read", "inspect", "write"], layers: ["selected"], views: [], sensitive: false }] });
    const port = controller.forIdentity(token, { identity, namespace: "/example" }); await port.prepare();
    if (port.get(["enabled"]) !== true || port.inspect(["enabled"]).effective.value !== true || "get" in root) throw Error("hosted read mismatch");
    if (JSON.stringify(port.get()) !== JSON.stringify({ enabled: true })) throw Error("aggregate projection mismatch");
    let hiddenValidationDenied = false;
    try { port.validate(); } catch (error) { hiddenValidationDenied = error.code === "FORBIDDEN"; }
    if (!hiddenValidationDenied) throw Error("validation disclosed hidden data");
    if ((await controller.forMutations(token).apply([{ identity, namespace: "/example", layer: "selected", operation: "set", path: "/example/enabled", value: false }])).error.code !== "WRITE_UNAVAILABLE") throw Error("writer enabled");
    controller.revoke(token);
    for (const read of [() => port.get(["enabled"]), () => port.inspect(["enabled"])]) {
      let denied = false; try { read(); } catch (error) { denied = error.code === "FORBIDDEN"; }
      if (!denied) throw Error("revoked capability exposed data");
    }
    if (loads !== 1 || writes !== 0) throw Error("unexpected provider effects");
  } finally { await root.dispose(); }
}
