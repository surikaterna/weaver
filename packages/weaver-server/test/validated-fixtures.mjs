import { BUILTIN_CATALOG_REFERENCE, internalRegistrationId, internalUpgradeLayerDigest } from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createControlService } from "../src/core/control-service.ts";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { scopeContextId } from "../src/core/scope-inventory.ts";
import assert from "node:assert/strict";

export function record(serviceId, schema) {
  return { version: 1, kind: "service", request: { serviceId, environment: "dev", owner: { name: "team", contact: "team@example.com" }, schema, fragmentSlots: [] }, audit: { actor: "test-owner" } };
}

export function upgradeLayerEvidence(provider, envelope, finalEntries, contentDomain) {
  const namespace = provider.authority.capabilities.namespace;
  const sourceDigest = internalUpgradeLayerDigest(envelope.entries, contentDomain);
  return {
    source: { providerId: provider.id, namespace, storeId: envelope.storeId, layer: envelope.layer, contentDomain, digest: sourceDigest },
    revision: { providerId: provider.id, revisions: [{ storeId: envelope.storeId, environment: envelope.environment, layer: envelope.layer, epoch: envelope.epoch, sequence: envelope.sequence }] },
    final: { providerId: provider.id, namespace, storeId: envelope.storeId, environment: envelope.environment, layer: envelope.layer, contentDomain, sourceDigest, finalDigest: internalUpgradeLayerDigest(finalEntries, contentDomain) },
  };
}

export function configuration(binding, providers, records = [], contexts = [], scopes = []) {
  return {
    format: { version: 1, ...binding, initialization: "uninitialized", builtinCatalog: { ...BUILTIN_CATALOG_REFERENCE } },
    catalog: { registrations: Object.fromEntries(records.map((item) => [internalRegistrationId(item), item])) },
    infrastructure: { activeGeneration: "g1", generations: { g1: {
      version: 1,
      layout: { layers: providers.map((provider) => fixtureLayer(provider, scopes)), scopes },
      providers: providers.map((provider) => ({ id: provider.id, factory: "memory", options: { durability: "volatile" } })),
      server: { port: 3399, auth: { credentialRef: "jwt", adminRoles: ["admin"] } },
    } } },
    scopeInventory: { version: 1, revision: "0", contexts: Object.fromEntries(contexts.map((entry) => [scopeContextId(entry.scopePath), entry])) },
    upgrades: { plans: {}, journal: {} },
  };
}

function fixtureLayer(provider, scopes) {
  const dimension = scopes.find((scope) => scope.id === provider.layer.split(":")[0]);
  const scopeIds = [];
  for (let scope = dimension; scope; scope = scopes.find((item) => item.id === scope.parentScopeId)) scopeIds.unshift(scope.id);
  return { name: provider.layer.includes(":") ? provider.id : provider.layer, type: dimension ? "dynamic" : "static", providerId: provider.id,
    config: { mergeId: "deep", ...(dimension ? { scopeIds } : {}) } };
}

export async function initialized({ data = {}, records = [], scopes = [], contexts = [], scoped = {}, environment = "dev", secretBackend } = {}) {
  const platform = createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries: data });
  const providers = [platform];
  for (const scope of scopes) {
    const provider = createInMemoryStorageProvider({ id: scope.id, layer: scope.id });
    for (const [layer, entries] of Object.entries(scoped)) {
      if (!layer.startsWith(`${scope.id}:`)) continue;
      await provider.loadLayer(layer);
      for (const [key, value] of Object.entries(entries)) assert.equal((await provider.writeLayer(layer, key, value)).success, true);
    }
    providers.push(provider);
  }
  const control = await createControlService({ environment, providers, ...(secretBackend ? { secretBackend } : {}) });
  const state = configuration(control.binding, providers, records, contexts, scopes);
  const draft = structuredClone(state);
  draft.catalog.registrations = {};
  draft.scopeInventory.contexts = {};
  assert.equal((await control.initialize(draft)).success, true);
  for (const item of records) assert.equal((await control.registerSchema(item.request)).success, true);
  assert.equal((await control.initializeInventory(state.scopeInventory, control.revision)).success, true);
  assert.equal((await control.finalize(control.revision)).success, true);
  const service = await control.application();
  return { service, platform, providers, state };
}
