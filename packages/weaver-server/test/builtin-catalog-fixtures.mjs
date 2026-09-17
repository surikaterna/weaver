import { BUILTIN_CATALOG_REFERENCE, canonicalInternalJson, internalRegistrationId, internalUpgradeLayerDigest } from "@weaver-conf/config-types";
import { createHash } from "node:crypto";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";

export const binding = { storeId: "fs:control", environment: "dev" };
export function catalogState() {
  return {
    format: { version: 1, ...binding, initialization: "initialized", builtinCatalog: { ...BUILTIN_CATALOG_REFERENCE } },
    catalog: { registrations: {} },
    infrastructure: { activeGeneration: "g1", generations: { g1: {
      version: 1, layout: { layers: [{ name: "platform", type: "static", providerId: "disk", config: { mergeId: "deep" } }], scopes: [] },
      providers: [{ id: "disk", factory: "fs", options: { filePath: "/var/weaver/control.json" } }],
      server: { port: 3399, auth: { credentialRef: "jwt", adminRoles: ["admin"] } },
    } } },
    scopeInventory: { version: 1, revision: "0", contexts: {} },
    upgrades: { plans: {}, journal: {} },
  };
}
export function registrationRecord(schema = { type: "object" }) {
  return { version: 1, kind: "service", request: { serviceId: "svc", environment: "dev", owner: { name: "Service", contact: "service@example.test" }, schema, fragmentSlots: [] }, audit: { actor: "admin" } };
}
export function addRegistration(state, record) {
  state.catalog.registrations[internalRegistrationId(record)] = record;
}
export const revision = { storeId: "fs:data", environment: "dev", layer: "platform", epoch: "11111111-1111-4111-8111-111111111111", sequence: "1" };
export function trustedAuthorities(sources = [{ providerId: "disk", revision }]) {
  const grouped = new Map();
  for (const source of sources) {
    const revisions = grouped.get(source.providerId) ?? [];
    revisions.push(structuredClone(source.revision));
    grouped.set(source.providerId, revisions);
  }
  return [...grouped].map(([providerId, revisions]) => ({
    providerId,
    definition: providerId === "disk"
      ? { id: "disk", factory: "fs", options: { filePath: "/var/weaver/control.json" } }
      : { id: providerId, factory: "fs", options: { filePath: `/var/weaver/${providerId}.json` } },
    namespace: "fs:/var/weaver",
    revisions,
  }));
}
export function upgradePlan() {
  const layer = upgradeLayerBinding("disk", revision, {}, {});
  const body = { version: 1, source: { catalogDigest: "a".repeat(64), dataDigests: [layer.source], providerRevisions: [{ providerId: "disk", revisions: [structuredClone(revision)] }], inventoryRevision: "0", infrastructureGeneration: "g1" }, target: { catalogDigest: "c".repeat(64) }, contexts: [[]], steps: [], finalLayers: [layer.final], refusals: [] };
  return { ...body, id: createHash("sha256").update(canonicalInternalJson(body)).digest("hex") };
}
export function recoveryEnvelope() {
  return { version: 1, runId: "22222222-2222-4222-8222-222222222222", planId: upgradePlan().id,
    source: { ...BUILTIN_CATALOG_REFERENCE }, target: { id: "invalid-target-catalog", version: 99, digest: "f".repeat(64) },
    infrastructureGeneration: "g1", owner: "33333333-3333-4333-8333-333333333333", phase: "prepared", steps: [],
  };
}

export function dataReceipt(step, previous = step.preRevision) {
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  const mutation = step.mutation.action === "set" ? { action: "set", key, value: step.mutation.value } : { action: "remove", key };
  const request = { layer: step.target.layer, expectedRevision: previous, operationId: step.operationId, mutation };
  return { operationId: step.operationId, previousRevision: previous, revision: { ...previous, sequence: String(BigInt(previous.sequence) + 1n) }, mutationDigest: computeProviderMutationDigest(request) };
}

export function completedJournal() {
  const journal = recoveryEnvelope(); journal.phase = "completed";
  const step = { id: "s1", target: { providerId: "disk", namespace: "fs:/var/weaver", storeId: revision.storeId, layer: revision.layer, path: "/svc/port" }, operationId: "44444444-4444-4444-8444-444444444444", preRevision: structuredClone(revision), preDigest: "a".repeat(64), postDigest: "b".repeat(64), mutation: { action: "set", value: 80 }, status: "complete", intentOperationId: "55555555-5555-4555-8555-555555555555" };
  step.receipt = dataReceipt(step);
  journal.steps = [step];
  journal.cursor = [{ providerId: "disk", revision: structuredClone(step.receipt.revision) }];
  return journal;
}

export function upgradeLayerBinding(providerId, sourceRevision, sourceEntries, finalEntries) {
  const namespace = "fs:/var/weaver";
  const contentDomain = "layer-entries-v1";
  const sourceDigest = internalUpgradeLayerDigest(sourceEntries, contentDomain);
  return {
    source: { providerId, namespace, storeId: sourceRevision.storeId, layer: sourceRevision.layer, contentDomain, digest: sourceDigest },
    final: { providerId, namespace, storeId: sourceRevision.storeId, environment: sourceRevision.environment, layer: sourceRevision.layer, contentDomain, sourceDigest, finalDigest: internalUpgradeLayerDigest(finalEntries, contentDomain) },
  };
}

export function identifyPlan(body) {
  const { id: _id, ...content } = body;
  return { ...content, id: createHash("sha256").update(canonicalInternalJson(content)).digest("hex") };
}
