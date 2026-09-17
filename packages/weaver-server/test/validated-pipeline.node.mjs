import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { internalRegistrationId } from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createControlService } from "../src/core/control-service.ts";
import { controlTransaction } from "../src/core/config-service-internal.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { createScopeManager } from "../src/core/scope-manager.ts";
import { createRestAdapter } from "../src/transport/rest-adapter.ts";
import { configuration, initialized, record, upgradeLayerEvidence } from "./validated-fixtures.mjs";
import { prepareTestService } from "./setup-service.ts";
import { transitionDigest } from "../src/core/schema-transition.ts";
import { randomUUID } from "node:crypto";
import { getProviderRevision } from "@weaver-conf/storage-providers";
import { bindProviderDefinition } from "../src/core/provider-definition-binding.ts";

const schema = { type: "object", required: ["n"], properties: { n: { type: "number" }, mode: { type: "string", default: "safe" } }, additionalProperties: false };

test("hywh/4z58: bootstrap is code-validated and missing initialization cannot serve apps", async () => {
  const platform = createInMemoryStorageProvider({ id: "platform", layer: "platform" });
  await assert.rejects(createWeaverConfigService({ providers: [platform], environment: "dev" }));
  const control = await createControlService({ providers: [platform], environment: "dev" });
  const state = configuration(control.binding, [platform]);
  const before = await platform.load();
  const invalid = structuredClone(state);
  invalid.format.builtinCatalog.digest = "0".repeat(64);
  assert.equal((await control.initialize(invalid)).success, false);
  assert.deepEqual(await platform.load(), before);
  assert.equal((await control.initialize(state)).success, true);
  assert.equal((await control.finalize(control.revision)).success, true);
  await control.close();
  const service = await createWeaverConfigService({ providers: [platform], environment: "dev" });
  try {
    const revision = service.revision;
    for (const result of [await service.set("platform", "rogue", 1), await service.remove("platform", "rogue"), await service.setMany("platform", { rogue: 1 })]) assert.equal(result.success, false);
    await assert.rejects(service.get("rogue"));
    assert.deepEqual((await service.resolveAll()).entries, {});
    assert.equal(service.revision, revision);
    assert.equal((await service.set("platform", "_weaver.scopeInventory", {}, { internal: true })).success, false);
    await assert.rejects(controlTransaction(service, "catalog", ({ write }) => write("_weaver.scopeInventory", state.scopeInventory)), { code: "FORBIDDEN" });
    await assert.rejects(controlTransaction(service, "scope", ({ write }) => write("_weaver.format", state.format)), { code: "FORBIDDEN" });
  } finally { await service.close(); }
});

test("9qje: two registry handles serialize canonical disjoint records and reconstruct on restart", async () => {
  const f = await initialized();
  const first = createSchemaRegistry({ configService: f.service });
  const second = createSchemaRegistry({ configService: f.service });
  const requests = [record("one", { type: "object" }).request, record("two", { type: "object" }).request];
  const results = await Promise.all(requests.map((request, index) => (index ? second : first).register(request, { actor: "admin" })));
  assert.ok(results.every((result) => result.success));
  assert.equal(Object.keys(first.listAll()).length, 2);
  const returned = await first.getSchema("one", "dev");
  returned.type = "string";
  assert.equal((await second.getSchema("one", "dev")).type, "object");
  await f.service.close();
  const restarted = await createWeaverConfigService({ providers: f.providers, environment: "dev" });
  try {
    const registry = createSchemaRegistry({ configService: restarted });
    assert.equal(Object.keys(registry.listAll()).length, 2);
    assert.equal((await f.platform.load()).entries._weaver.registry, undefined);
    assert.equal(Object.keys((await f.platform.load()).entries._weaver.catalog.registrations).length, 2);
  } finally { await restarted.close(); }
});

test("hywh/4z58: internal records are schema data, not public marker-stripped application objects", async () => {
  const f = await initialized();
  try {
    const registry = createSchemaRegistry({ configService: f.service });
    const value = record("svc", schema);
    assert.equal((await registry.register(value.request)).success, true);
    const stored = (await f.platform.load()).entries._weaver.catalog.registrations[internalRegistrationId(value)];
    assert.equal(stored.request.schema.properties.mode.default, "safe");
    const revision = f.service.revision;
    const malformed = { ...value, request: { ...value.request, schema: { type: "string" } } };
    const result = await controlTransaction(f.service, "catalog", ({ write }) => write(`_weaver.catalog.registrations.${internalRegistrationId(value)}`, malformed));
    assert.equal(result.success, false);
    assert.equal(f.service.revision, revision);
    assert.equal((await f.service.set("platform", "svc", { n: 1 })).success, true);
    assert.deepEqual(await f.service.getNamespace("svc"), { n: 1, mode: "safe" });
    assert.equal(await f.service.get("_weaver.catalog"), undefined);
    const rest = createRestAdapter({ configService: f.service, schemaRegistry: registry });
    const response = await rest.handleRequest("GET", "/v1/config", { params: {}, query: {}, headers: {} });
    assert.ok(!JSON.stringify(response.body).includes("catalog"));
  } finally { await f.service.close(); }
});

test("29r: missing/stale revision and a candidate invalidating one cold scope do not activate", async () => {
  const path = [{ scopeId: "tenant", value: "cold" }];
  const f = await initialized({ records: [record("svc", schema)], data: { svc: { n: 1 } },
    scopes: [{ id: "tenant", label: "Tenant" }], contexts: [{ scopePath: path, state: "active" }], scoped: { "tenant:cold": { svc: { n: 2 } } } });
  try {
    const registry = createSchemaRegistry({ configService: f.service });
    const events = [];
    f.service.onDelta((event) => events.push(event));
    const revision = f.service.revision;
    const before = await f.platform.load();
    const tightening = record("svc", { ...schema, properties: { ...schema.properties, n: { type: "number", maximum: 1 } } }).request;
    assert.equal((await registry.register(tightening)).error.code, "REVISION_CONFLICT");
    assert.equal((await registry.register(tightening, { expectedRevision: revision })).success, false);
    assert.equal(f.service.revision, revision);
    assert.deepEqual(await f.platform.load(), before);
    assert.equal(events.length, 0);
    const permissive = record("svc", { ...schema, additionalProperties: true }).request;
    const accepted = await registry.register(permissive, { expectedRevision: revision });
    assert.equal(accepted.success, true);
    assert.equal(accepted.compatibility, "unknown");
    assert.equal(accepted.hasBreakingChanges, true);
    assert.equal((await registry.register(tightening, { expectedRevision: revision })).error.code, "REVISION_CONFLICT");
  } finally { await f.service.close(); }
});

test("fteq: lifecycle writes current inventory conditionally; failed persistence leaves it unchanged", async () => {
  const path = [{ scopeId: "tenant", value: "cold" }];
  const f = await initialized({ records: [record("svc", schema)], data: { svc: { n: 1 } },
    scopes: [{ id: "tenant", label: "Tenant" }], contexts: [{ scopePath: path, state: "retired" }], scoped: { "tenant:cold": { svc: { n: 2 } } } });
  try {
    const manager = createScopeManager({ configService: f.service });
    const before = await f.platform.load();
    const revision = f.service.revision;
    const fault = mock.method(f.platform.authority, "commitLayer", async () => ({ success: false, error: { code: "VALIDATION_ERROR", message: "injected" } }));
    assert.equal((await manager.provision({ scopePath: path, actor: "admin" })).success, false);
    fault.mock.restore();
    assert.equal(f.service.revision, revision);
    assert.deepEqual(await f.platform.load(), before);
    assert.deepEqual(manager.listScopeValues("tenant"), []);
    assert.equal((await manager.provision({ scopePath: path, actor: "admin", expectedRevision: revision })).success, true);
    assert.deepEqual(await f.service.getNamespace("svc", { scopePath: path }), { n: 2, mode: "safe" });
    const active = f.service.revision;
    assert.equal((await manager.provision({ scopePath: path, actor: "admin" })).revision, active);
    assert.equal((await manager.deprovision({ scopePath: path, actor: "admin", expectedRevision: revision })).success, false);
    assert.equal((await manager.deprovision({ scopePath: path, actor: "admin", expectedRevision: active })).success, true);
    await assert.rejects(f.service.get("svc", { scopePath: path }), { code: "SCOPE_NOT_FOUND" });
    assert.equal((await manager.provision({ scopeId: "tenant", value: "not-prepared", actor: "admin" })).success, false);
  } finally { mock.restoreAll(); await f.service.close(); }
});

test("4z58: invalid reload keeps the prior snapshot private and recovers only after valid reload", async () => {
  const f = await initialized({ records: [record("svc", schema)], data: { svc: { n: 1 } } });
  try {
    const before = await f.platform.authority.readLayer("platform");
    const invalid = structuredClone(before);
    invalid.entries.svc.n = "invalid";
    const fault = mock.method(f.platform.authority, "readLayer", async () => invalid);
    const events = [];
    f.service.onDelta((event) => events.push(event));
    await assert.rejects(f.service.reloadProvider("platform"));
    await assert.rejects(f.service.get("svc.n"));
    assert.deepEqual(events, []);
    fault.mock.restore();
    await f.service.reloadProvider("platform");
    assert.equal(await f.service.get("svc.n"), 1);
  } finally { mock.restoreAll(); await f.service.close(); }
});

test("29r: run-bound full-object repair validates the target without authorizing invalid public source", async () => {
  const data = createInMemoryStorageProvider({ id: "appdata", layer: "application", environment: "default", initialEntries: { svc: { n: 1 } } });
  const options = await prepareTestService({ providers: [data], environment: "default" }, { svc: schema });
  const application = await createWeaverConfigService(options);
  await application.close();
  assert.equal((await data.write("svc", { n: "invalid-source" })).success, true);
  await assert.rejects(createWeaverConfigService(options));
  const control = await createControlService(options);
  try {
    const source = await data.authority.readLayer("application");
    const controlProvider = options.providers[0];
    const controlSource = await controlProvider.authority.readLayer(controlProvider.layer);
    const state = controlSource.entries._weaver;
    for (const definition of state.infrastructure.generations.g1.providers) {
      const provider = options.providers.find((item) => item.id === definition.id);
      assert.ok(provider);
      bindProviderDefinition(provider, definition);
    }
    const value = { n: 2 };
    const target = { providerId: "appdata", namespace: data.authority.capabilities.namespace, storeId: source.storeId, layer: "application", path: "/svc" };
    const revision = getProviderRevision(source);
    const step = { id: "repair", target, expectedRevision: revision, preDigest: transitionDigest(source.entries.svc), postDigest: transitionDigest(value), mutation: { action: "set", value }, reversible: false };
    const dataLayer = upgradeLayerEvidence(data, source, { ...source.entries, svc: value }, "layer-entries-v1");
    const controlLayer = upgradeLayerEvidence(controlProvider, controlSource, controlSource.entries, "control-application-v1");
    const layers = [dataLayer, controlLayer];
    const body = { version: 1, source: { catalogDigest: transitionDigest(state.catalog), dataDigests: layers.map((layer) => layer.source), providerRevisions: layers.map((layer) => layer.revision), inventoryRevision: "0", infrastructureGeneration: "g1" }, target: { catalogDigest: transitionDigest(state.catalog) }, contexts: [[]], steps: [step], finalLayers: layers.map((layer) => layer.final), refusals: [] };
    const plan = { ...body, id: transitionDigest(body) };
    const storedPlan = await control.storePlan(plan, control.revision);
    assert.equal(storedPlan.success, true, storedPlan.error?.message);
    const operationId = randomUUID(); const runId = randomUUID();
    const sources = [{ providerId: "appdata", revision }, { providerId: controlProvider.id, revision: controlLayer.revision.revisions[0] }];
    const pending = { version: 1, runId, planId: plan.id, owner: control.owner, source: state.format.builtinCatalog, target: state.format.builtinCatalog, infrastructureGeneration: "g1", phase: "prepared", sourceRevisions: sources, control: { providerId: controlProvider.id, revision: controlLayer.revision.revisions[0], receipts: [], operationId: randomUUID() }, steps: [{ id: "repair", target, preRevision: revision, preDigest: step.preDigest, postDigest: step.postDigest, mutation: step.mutation, operationId, status: "pending" }] };
    const storedJournal = await control.recordJournal(pending, control.revision);
    assert.equal(storedJournal.success, true, storedJournal.error?.message);
    const recorded = await control.readRecovery(runId);
    const applying = { ...recorded, phase: "applying", cursor: sources, steps: [{ ...recorded.steps[0], status: "intent", intentOperationId: operationId }] };
    assert.equal((await control.replaceJournal(applying, control.revision)).success, true);
    await assert.rejects(control.repairStep(runId, "repair", "stale"), { code: "REVISION_CONFLICT" });
    const result = await control.repairStep(runId, "repair", control.revision);
    assert.equal(result.success, true);
    const persisted = await data.authority.readLayer("application");
    assert.deepEqual(persisted.entries.svc, value);
    assert.equal(persisted.lastCommit.operationId, operationId);
    assert.equal((await control.readRecovery(runId)).steps[0].status, "intent");
    await assert.rejects(control.repairStep(runId, "repair", control.revision), { code: "REVISION_CONFLICT" });
  } finally { await control.close(); }
  await assert.rejects(createWeaverConfigService(options), /Maintenance recovery is pending/);
});
