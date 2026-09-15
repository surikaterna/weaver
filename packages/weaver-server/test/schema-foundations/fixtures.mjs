import { deepSet, deepRemove } from "@weaver-conf/config-engine";
import { fixtureStorage } from "./storage-fixture.mjs";
import { createControlService } from "../../src/core/control-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { compileInternalRegistrations } from "@weaver-conf/config-engine";
import { internalRegistrationId } from "@weaver-conf/config-types";
import { configuration } from "../validated-fixtures.mjs";
import { scopeContextId } from "../../src/core/scope-inventory.ts";
import assert from "node:assert/strict";

export const owner = { name: "svc", contact: "svc@example.com" };
export const registration = (schema, fragmentSlots = []) => ({ serviceId: "svc", environment: "dev", owner, schema, fragmentSlots });

/** Explicit draft setup: tests declare schemas, then activate through the real validated control API. */
export async function fixture(entries = { svc: {} }, profile = "memory", extraProviders = [], paths = []) {
  const data = structuredClone(entries);
  const writes = [];
  const provider = { id: "p", layer: "platform", writable: true,
    async load() { return { entries: structuredClone(data) }; },
    async write(key, value) { writes.push({ key, value }); deepSet(data, key, structuredClone(value)); return { success: true }; },
    async remove(key) { writes.push({ key }); deepRemove(data, key); return { success: true }; },
  };
  const storageFixture = await fixtureStorage(profile);
  const { storage, filePath } = storageFixture;
  const providers = [storage, provider, ...extraProviders];
  const control = await createControlService({ providers, environment: "dev", controlLayer: "control" });
  storageFixture.verifyAfterTest(control, providers.slice(1));
  const scopes = [...new Map(paths.flatMap((path) => path.map((scope, index) => [scope.scopeId, { id: scope.scopeId, label: scope.scopeId, ...(index ? { parentScopeId: path[index - 1].scopeId } : {}) }]))).values()];
  const initial = configuration(control.binding, providers, [], [], scopes);
  if (filePath) initial.infrastructure.generations.g1.providers[0] = { id: "control", factory: "fs", options: { filePath } };
  assert.equal((await control.initialize(initial)).success, true);
  const configService = control.configuration;
  const registry = createSchemaRegistry({ configService });
  const activate = async () => {
    const inventory = { version: 1, revision: "0", contexts: Object.fromEntries(paths.map((scopePath) => [scopeContextId(scopePath), { scopePath, state: "active" }])) };
    const scoped = await control.initializeInventory(inventory, control.revision);
    assert.equal(scoped.success, true, scoped.error?.message);
    const finalized = await control.finalize(control.revision);
    assert.equal(finalized.success, true, finalized.error?.message);
    return control.application();
  };
  return { configService, registry, provider, data, writes, activate, control, storage, providers };
}

export function validateCanonicalSchema(schema, kind = "service") {
  const parent = { version: 1, kind: "service", request: registration({ type: "object" }, [{ slotPath: "/plugins", accepts: "object" }]), audit: { actor: "fixture" } };
  const record = kind === "service" ? { version: 1, kind, request: registration(schema), audit: { actor: "fixture" } } : { version: 1, kind, request: { serviceId: "svc", providerId: "plugin", slotPath: "/plugins", environment: "dev", owner, schema }, audit: { actor: "fixture" } };
  return compileInternalRegistrations({ registrations: Object.fromEntries((kind === "service" ? [record] : [parent, record]).map((entry) => [internalRegistrationId(entry), entry])) });
}
