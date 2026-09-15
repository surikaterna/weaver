import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  deepGet,
  deepRemove,
  deepSet,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import {
  BUILTIN_CATALOG_REFERENCE,
  canonicalInternalJson,
  internalRecoveryEnvelopeSchema,
  internalUpgradeLayerDigest,
  internalUpgradePlanSchema,
} from "@weaver-conf/config-types";
import { getProviderRevision } from "@weaver-conf/storage-providers";
import { hostForControl, controlTransaction } from "../src/core/config-service-internal.ts";
import {
  prepareInitialJournal,
  prepareJournalReplacement,
} from "../src/core/control-journal-lineage.ts";
import { transitionDigest } from "../src/core/schema-transition.ts";
import { activateUpgradePlan } from "../src/core/upgrade-executor.ts";
import { onlyJournal } from "./upgrade-final-matrix-fixture.mjs";

export async function prepareDurableFinalFailure(
  fixture,
  runtime,
  request,
  target,
  value,
) {
  const preview = await runtime.planUpgrade(request);
  assert.equal(preview.result.status, "ready", canonicalInternalJson(preview));
  const prepared = await customPlan(runtime, preview.result.plan, target, value);
  const owner = randomUUID();
  await runtime.enterMaintenance();
  await storePlan(runtime, prepared.plan);
  let journal = await createJournal(runtime, prepared.plan, owner);
  for (const step of prepared.plan.steps)
    journal = await executeStep(runtime, prepared.plan, journal, step);
  journal = await replaceJournal(runtime, journal, { ...journal, phase: "verifying" });
  const control = provider(runtime, "control");
  const durable = await control.authority.readLayer(control.layer);
  assert.deepEqual(onlyJournal(durable), journal);
  assert.ok(journal.steps.every((step) => step.status === "complete"));
  return { fixture, plan: prepared.plan, journal, control };
}

export function runDurableFinalValidation(runtime, prepared) {
  const runtimeHost = {
    configService: runtime.configService,
    enterMaintenance: () => runtime.enterMaintenance(),
    requireRestart: () => runtime.requireRestart(),
  };
  const control = {
    readRecovery: async (runId) => {
      const envelope = await prepared.control.authority.readLayer(prepared.control.layer);
      return internalRecoveryEnvelopeSchema.parse(
        envelope.entries._weaver.upgrades.journal[runId],
      );
    },
  };
  const admission = {
    fresh: async () => assert.fail("invalid final state must not be admitted"),
    terminal: async () => assert.fail("invalid final state must not be admitted"),
  };
  return activateUpgradePlan(runtimeHost, control, prepared.plan, prepared.journal, admission);
}

async function customPlan(runtime, source, target, value) {
  const envelopes = await readEnvelopes(runtime);
  const simulated = new Map(
    [...envelopes].map(([key, envelope]) => [key, structuredClone(envelope)]),
  );
  for (const step of source.steps) simulateStep(simulated, step);
  const marker = markerStep(runtime, simulated, target, value);
  simulateStep(simulated, marker);
  const body = {
    ...source,
    steps: [...source.steps, marker],
    finalLayers: source.finalLayers.map((binding) => {
      const envelope = simulated.get(layerKey(binding.providerId, binding.layer));
      return {
        ...binding,
        finalDigest: internalUpgradeLayerDigest(envelope.entries, binding.contentDomain),
      };
    }),
  };
  delete body.id;
  return { plan: internalUpgradePlanSchema.parse({ ...body, id: digest(body) }) };
}

function markerStep(runtime, simulated, target, value) {
  const selected = target === "base"
    ? { providerId: "platform", layer: "platform" }
    : { providerId: target.split(":")[0], layer: target };
  const provider = providerForId(runtime, selected.providerId);
  const envelope = simulated.get(layerKey(provider.id, selected.layer));
  const prior = deepGet(envelope.entries, "svc.marker");
  const body = {
    target: {
      providerId: provider.id,
      namespace: provider.authority.capabilities.namespace,
      storeId: envelope.storeId,
      layer: selected.layer,
      path: "/svc/marker",
    },
    expectedRevision: getProviderRevision(envelope),
    preDigest: transitionDigest({ absent: prior === undefined, ...(prior === undefined ? {} : { value: prior }) }),
    postDigest: transitionDigest({ absent: false, value }),
    mutation: { action: "set", value },
    reversible: true,
    undo: prior === undefined ? { action: "remove" } : { action: "set", value: prior },
  };
  return { id: `s${digest(body).slice(0, 31)}`, ...body };
}

function simulateStep(envelopes, step) {
  const envelope = envelopes.get(layerKey(step.target.providerId, step.target.layer));
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  if (step.mutation.action === "remove") deepRemove(envelope.entries, key);
  else deepSet(envelope.entries, key, structuredClone(step.mutation.value));
  envelope.sequence = `${BigInt(envelope.sequence) + 1n}`;
}

async function readEnvelopes(runtime) {
  const result = new Map();
  for (const candidate of runtime.configService.providers) {
    const inventory = await candidate.authority.inventory();
    for (const revision of inventory.revisions)
      result.set(
        layerKey(candidate.id, revision.layer),
        await candidate.authority.readLayer(revision.layer),
      );
  }
  return result;
}

async function storePlan(runtime, plan) {
  const result = await controlTransaction(runtime.configService, "maintenance", ({ write }) =>
    write(`_weaver.upgrades.plans.${plan.id}`, plan, {
      expectedRevision: runtime.configService.revision,
    }));
  assert.equal(result.success, true);
}

async function createJournal(runtime, plan, owner) {
  const controlProvider = provider(runtime, "control");
  const controlRevision = plan.source.providerRevisions
    .find((item) => item.providerId === controlProvider.id)
    ?.revisions.find((revision) => revision.layer === controlProvider.layer);
  assert.ok(controlRevision);
  const initial = {
    version: 1,
    runId: randomUUID(),
    planId: plan.id,
    owner,
    source: BUILTIN_CATALOG_REFERENCE,
    target: plan.target.builtinCatalog ?? BUILTIN_CATALOG_REFERENCE,
    infrastructureGeneration: plan.source.infrastructureGeneration,
    phase: "prepared",
    activation: { status: "pending" },
    sourceRevisions: cursorFor(plan),
    control: {
      providerId: controlProvider.id,
      revision: controlRevision,
      receipts: [],
      operationId: randomUUID(),
    },
    steps: plan.steps.map((step) => ({
      id: step.id,
      target: step.target,
      operationId: randomUUID(),
      preRevision: step.expectedRevision,
      preDigest: step.preDigest,
      postDigest: step.postDigest,
      mutation: step.mutation,
      ...(step.undo ? { undo: step.undo } : {}),
      status: "pending",
    })),
  };
  const prepared = await prepareInitialJournal(runtime.configService, initial);
  await writeJournal(runtime, prepared);
  return replaceJournal(runtime, prepared, {
    ...prepared,
    phase: "applying",
    cursor: cursorFor(plan),
  });
}

async function executeStep(runtime, plan, journal, step) {
  const index = plan.steps.findIndex((item) => item.id === step.id);
  const intent = {
    ...journal.steps[index],
    status: "intent",
    intentOperationId: randomUUID(),
  };
  let current = await replaceJournal(runtime, journal, {
    ...journal,
    steps: journal.steps.map((item, itemIndex) => itemIndex === index ? intent : item),
  });
  const provider = providerForId(runtime, step.target.providerId);
  const host = hostForControl(runtime.configService);
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  const committed = await host.authority.commit(
    provider,
    step.target.layer,
    key,
    step.mutation.action === "set" ? step.mutation.value : undefined,
    step.mutation.action === "remove",
    intent.operationId,
  );
  assert.equal(committed.result.success, true);
  const envelope = await provider.authority.readLayer(step.target.layer);
  assert.equal(envelope.lastCommit.operationId, intent.operationId);
  const complete = { ...intent, status: "complete", receipt: envelope.lastCommit };
  current = await replaceJournal(runtime, current, {
    ...current,
    cursor: replaceCursor(current, provider.id, getProviderRevision(envelope)),
    steps: current.steps.map((item, itemIndex) => itemIndex === index ? complete : item),
  });
  return current;
}

async function replaceJournal(runtime, previous, next) {
  const prepared = await prepareJournalReplacement(
    runtime.configService,
    previous,
    internalRecoveryEnvelopeSchema.parse(next),
    randomUUID(),
  );
  await writeJournal(runtime, prepared);
  return prepared;
}

async function writeJournal(runtime, journal) {
  const result = await controlTransaction(runtime.configService, "maintenance", ({ write }) =>
    write(`_weaver.upgrades.journal.${journal.runId}`, journal, {
      expectedRevision: runtime.configService.revision,
      ...(journal.control ? { operationId: journal.control.operationId } : {}),
    }));
  assert.equal(result.success, true);
}

function cursorFor(plan) {
  return plan.source.providerRevisions.flatMap((item) =>
    item.revisions.map((revision) => ({ providerId: item.providerId, revision })));
}

function replaceCursor(journal, providerId, revision) {
  return journal.cursor.map((item) =>
    item.providerId === providerId && item.revision.layer === revision.layer
      ? { providerId, revision }
      : item);
}

function provider(runtime, id) {
  return providerForId(runtime, id);
}

function providerForId(runtime, id) {
  const result = runtime.configService.providers.find((item) => item.id === id);
  assert.ok(result?.authority);
  return result;
}

function layerKey(providerId, layer) {
  return canonicalInternalJson([providerId, layer]);
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
