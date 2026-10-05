import * as service from "@weaver-conf/config-service";
import * as admission from "@weaver-conf/config-service/admission";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";
import { createCanonicalSchemaRegistry } from "@weaver-conf/config-registry";
import { defineWeaver, Layers } from "@weaver-conf/config-types";

export const exports = Object.keys(service);
export const admissionExports = Object.keys(admission);
export async function exercise() {
  const provider = { id: "memory", layer: "base", writable: true,
    async load() { return { entries: { example: { cfg: { a: 1, b: 2 }, unknown: "PRIVATE", hidden: "SECRET" } } }; },
    async write() { throw Error("unexpected write"); }, async remove() { throw Error("unexpected remove"); } };
  const later = { ...provider, id: "later", layer: "later", async load() { return { entries: { example: { cfg: { a: 1, c: 3 } } } }; } };
  const root = await service.createConfigurationService({ identity: { environment: "test", scopePath: [] }, schemas: [{ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { cfg: { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } } }, hidden: { type: "string", "x-weaver": { sensitive: true } } } } }],
    layers: [{ kind: "fixed", layer: "base", providerIds: ["memory"] }, { kind: "fixed", layer: "later", providerIds: ["later"] }],
    providers: [provider, later].map((provider) => ({ id: provider.id, layer: provider.layer, provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" } })) });
  try {
    const inspection = root.inspect("/example/cfg/a");
    if (root.get("/example/cfg/b") !== 2 || inspection.effectiveLayer !== "later" || root.inspect("/example/cfg").effectiveLayer !== undefined) throw Error("provenance mismatch");
    if (/PRIVATE|SECRET/.test(JSON.stringify(root.getNamespace("/example")))) throw Error("projection leak");
    await exerciseHost();
    return { revision: root.revision, winner: inspection.effectiveLayer, synchronous: typeof root.get("/example/cfg/a") === "number" };
  } finally { await root.dispose(); }
}

export async function exerciseWrites() {
  const entries = { example: { enabled: true, hidden: "PRIVATE" } };
  let controller, writes = 0, removes = 0, flushes = 0;
  const provider = { id: "writable", layer: "selected", writable: true,
    async load() { return { entries: structuredClone(entries) }; },
    async write(key, value) { writes++; deepSet(entries, key, value); return { success: true }; },
    async remove(key) { removes++; deepRemove(entries, key); return { success: true }; },
    async flush() { flushes++; } };
  const identity = { environment: "test", scopePath: [] }, registry = createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
  const registered = registry.register({ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: { enabled: { type: "boolean" }, hidden: { type: "string", "x-weaver": { sensitive: true } } } } });
  if (!registered.success) throw Error("registration failed");
  const prepared = admission.prepareConfigMutation({ registry, environment: "test", layerBefore: entries, effectiveAfter: (value) => value, mutations: [{ key: "example.enabled", operation: "set", value: false }] });
  if (!prepared.success || prepared.layerAfter.example.enabled !== false) throw Error("shared admission failed");
  const root = await service.createConfigurationService({ identity, schemas: [], layers: [{ kind: "fixed", layer: "selected", providerIds: [provider.id] }],
    providers: [{ id: provider.id, layer: provider.layer, provider, environment: { kind: "environments", environments: ["test"] }, operation: { kind: "load" }, ownership: { kind: "borrowed" } }] }, {
    registry, authConfig: { weaverConfig: defineWeaver([Layers.Static("selected")]), visibilityRoles: { admin: new Set(), platform: new Set() }, layerWritePolicies: [{ layer: "selected", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
    writers: [{ providerId: provider.id, operation: { kind: "write" }, flush: "required", failureSemantics: "unknown" }],
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" }, onAuthorityReady(value) { controller = value; },
  });
  try {
    const token = controller.mint({ principalId: "verified-writer", roles: ["editor"], grants: [{ identity, namespace: "/example", operations: ["read", "inspect", "write"], layers: ["selected"], views: [], sensitive: false }] });
    controller.bindRoot(token); const port = controller.forIdentity(token, identity, "/example");
    if (!(await root.set("/example/enabled", false, { layer: "selected", ifRevision: root.revision })).success || port.get("/example/enabled") !== false || entries.example.enabled !== false) throw Error("write publication failed");
    if ((await port.set("/example/hidden", "exposed", { layer: "selected" })).success) throw Error("private write allowed");
    if (!(await port.remove("/example/enabled", { layer: "selected" })).success || root.get("/example/enabled") !== undefined || "enabled" in entries.example) throw Error("remove failed");
    if (writes !== 1 || removes !== 1 || flushes !== 2) throw Error("wrong provider effects");
  } finally { await root.dispose(); }
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
    const port = controller.forIdentity(token, identity, "/example"); await port.prepare(); controller.bindRoot(token);
    if (root.get("/example/enabled") !== true || port.get("/example/enabled") !== true || root.inspect("/example/enabled").effective.value !== true) throw Error("hosted read mismatch");
    if ((await port.set("/example/enabled", false, { layer: "selected" })).error.code !== "WRITE_UNAVAILABLE") throw Error("writer enabled");
    controller.revoke(token);
    for (const read of [() => root.get("/example/enabled"), () => port.inspect("/example/enabled")]) {
      let denied = false; try { read(); } catch (error) { denied = error.code === "FORBIDDEN"; }
      if (!denied) throw Error("revoked capability exposed data");
    }
    if (loads !== 1 || writes !== 0) throw Error("unexpected provider effects");
  } finally { await root.dispose(); }
}
