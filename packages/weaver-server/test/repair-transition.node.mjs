import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { canonicalInternalJson, sha256Hex } from "@weaver-conf/config-types";
import { createInMemoryStorageProvider, getProviderRevision } from "@weaver-conf/storage-providers";
import { hostForControl } from "../src/core/config-service-internal.ts";
import { createControlService } from "../src/core/control-service.ts";
import { transitionDigest } from "../src/core/schema-transition.ts";
import { prepareTestService } from "./setup-service.ts";
import { upgradeLayerEvidence } from "./validated-fixtures.mjs";

async function repairFixture(t, change, corruptStored = () => {}) {
  const data = createInMemoryStorageProvider({ id: "appdata", layer: "application", environment: "default", initialEntries: { svc: { n: 1 } } });
  const auxiliary = createInMemoryStorageProvider({ id: "auxiliary", layer: "auxiliary", environment: "default" });
  const options = await prepareTestService({ providers: [data, auxiliary], environment: "default" }, {
    svc: { type: "object", required: ["n"], properties: { n: { type: "number" } }, additionalProperties: false },
  });
  assert.equal((await data.write("svc", { n: "invalid-source" })).success, true);
  const control = await createControlService(options);
  t.after(() => control.close());
  const source = await data.authority.readLayer("application");
  const controlProvider = options.providers[0];
  const controlSource = await controlProvider.authority.readLayer(controlProvider.layer);
  const auxiliarySource = await auxiliary.authority.readLayer(auxiliary.layer);
  const state = controlSource.entries._weaver;
  const namespace = data.authority.capabilities.namespace;
  const contentDomain = "layer-entries-v1";
  const target = { providerId: data.id, namespace, storeId: source.storeId, layer: source.layer, path: "/svc" };
  const revision = getProviderRevision(source);
  const step = { id: "repair", target, expectedRevision: revision,
    preDigest: transitionDigest(source.entries.svc), postDigest: transitionDigest({ n: 2 }),
    mutation: { action: "set", value: { n: 2 } }, reversible: false };
  const layers = [
    upgradeLayerEvidence(data, source, { ...source.entries, svc: { n: 2 } }, contentDomain),
    upgradeLayerEvidence(auxiliary, auxiliarySource, auxiliarySource.entries, contentDomain),
    upgradeLayerEvidence(controlProvider, controlSource, controlSource.entries, "control-application-v1"),
  ];
  const body = { version: 1,
    source: { catalogDigest: transitionDigest(state.catalog),
      dataDigests: layers.map((layer) => layer.source), providerRevisions: layers.map((layer) => layer.revision), inventoryRevision: "0", infrastructureGeneration: "g1" },
    target: { catalogDigest: transitionDigest(state.catalog) }, contexts: [[]], steps: [step],
    finalLayers: layers.map((layer) => layer.final), refusals: [],
  };
  change(body, step);
  const plan = { ...body, id: sha256Hex(canonicalInternalJson(body)) };
  const storedPlan = await control.storePlan(plan, control.revision);
  assert.equal(storedPlan.success, true, storedPlan.error?.message);
  const journal = await storeRepairJournal({ control, controlProvider, controlSource, layers, plan, state, step });
  corruptStored(t, control, plan);
  return { control, data, controlProvider: options.providers[0], journal };
}

async function storeRepairJournal({ control, controlProvider, controlSource, layers, plan, state, step }) {
  const operationId = randomUUID();
  const sources = layers.map((layer) => ({ providerId: layer.revision.providerId, revision: layer.revision.revisions[0] }));
  const pending = { version: 1, runId: randomUUID(), planId: plan.id, owner: control.owner,
    source: state.format.builtinCatalog, target: state.format.builtinCatalog, infrastructureGeneration: "g1",
    phase: "prepared", sourceRevisions: sources, control: { providerId: controlProvider.id, revision: getProviderRevision(controlSource), receipts: [], operationId: randomUUID() }, steps: [{ id: step.id, target: step.target,
      preRevision: step.expectedRevision, preDigest: step.preDigest, postDigest: step.postDigest, mutation: step.mutation,
      operationId, status: "pending" }],
  };
  const storedJournal = await control.recordJournal(pending, control.revision);
  assert.equal(storedJournal.success, true, storedJournal.error?.message);
  const recorded = await control.readRecovery(pending.runId);
  const journal = { ...recorded, phase: "applying", cursor: sources,
    steps: [{ ...recorded.steps[0], status: "intent", intentOperationId: operationId }] };
  const replacedJournal = await control.replaceJournal(journal, control.revision);
  assert.equal(replacedJournal.success, true, replacedJournal.error?.message);
  return journal;
}

const cases = [
  ["raw preimage mismatch", "REVISION_CONFLICT", (_body, step) => { step.preDigest = "0".repeat(64); }],
  ["inventory changed since maintenance preflight", "REVISION_CONFLICT", (body) => { body.source.inventoryRevision = "9"; }],
  ["missing source digest", "REVISION_CONFLICT", () => {}, (t, control, plan) => {
    const contracts = hostForControl(control.configuration).pipeline.contracts;
    const current = contracts.prepared();
    const stored = structuredClone(current.configuration.upgrades.plans[plan.id]);
    stored.source.dataDigests = stored.source.dataDigests.filter((item) => item.providerId !== "auxiliary");
    const prepared = { ...current, configuration: { ...current.configuration, upgrades: {
      ...current.configuration.upgrades, plans: { ...current.configuration.upgrades.plans, [plan.id]: stored },
    } } };
    t.mock.method(contracts, "prepared", () => prepared);
  }],
  ["target catalog mismatch", "VALIDATION_ERROR", (body) => { body.target.catalogDigest = "0".repeat(64); }],
  ["invalid full target object", "VALIDATION_ERROR", (_body, step) => {
    step.mutation.value = { n: "still-invalid" }; step.postDigest = transitionDigest(step.mutation.value);
  }],
];

for (const [name, code, change, corruptStored] of cases) {
  test(`29r fenced repair rejects ${name} without target or metadata effects`, async (t) => {
    const f = await repairFixture(t, change, corruptStored);
    const before = await f.data.authority.readLayer("application");
    const metadata = await f.controlProvider.load();
    const revision = f.control.revision;
    const commit = t.mock.method(f.data.authority, "commitLayer");
    const result = await f.control.repairStep(f.journal.runId, "repair", revision)
      .catch((error) => ({ success: false, error }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, code);
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(f.control.revision, revision);
    assert.deepEqual(await f.data.authority.readLayer("application"), before);
    assert.deepEqual(await f.controlProvider.load(), metadata);
    await assert.rejects(f.control.application(), /Maintenance recovery is pending/);
  });
}
