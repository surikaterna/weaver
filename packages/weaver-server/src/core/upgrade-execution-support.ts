import {
  deepEqual,
  deepGet,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  type InternalUpgradeStep,
  internalUpgradeLayerDigest,
  type LayerEnvelope,
  type ProviderRevision,
  providerInventorySchema,
  type ValidatedFinalContextsBinding,
} from "@weaver-conf/config-types";
import {
  computeProviderMutationDigest,
  getProviderRevision,
} from "@weaver-conf/storage-providers";
import { catalogLayers } from "./authority-preflight";
import type { ConfigServiceController } from "./config-service-controller";
import {
  assertFinalLayerEvidence,
  finalLayerKey,
  validateFinalAuthorityLineage,
} from "./final-authority-lineage";
import { transitionDigest } from "./schema-transition";
import { validateScopeInventory } from "./scope-inventory";

export function cursorFor(plan: InternalUpgradePlan) {
  return plan.source.providerRevisions.flatMap((provider) =>
    provider.revisions.map((revision) => ({
      providerId: provider.providerId,
      revision,
    })),
  );
}

export function replaceCursor(
  journal: InternalRecoveryEnvelope,
  providerId: string,
  revision: ProviderRevision,
) {
  const cursor = "cursor" in journal ? [...(journal.cursor ?? [])] : [];
  const index = cursor.findIndex(
    (item) =>
      item.providerId === providerId && item.revision.layer === revision.layer,
  );
  if (index < 0) cursor.push({ providerId, revision });
  else cursor[index] = { providerId, revision };
  return cursor;
}

export function providerFor(
  host: ConfigServiceController,
  step: InternalUpgradeStep,
) {
  const provider = host.providers.find(
    (item) => item.id === step.target.providerId,
  );
  if (!provider?.authority)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Upgrade target authority is unavailable",
    );
  if (
    !("namespace" in provider.authority.capabilities) ||
    provider.authority.capabilities.namespace !== step.target.namespace
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Upgrade target namespace changed",
    );
  return provider;
}

export async function loadAllInventoryLayers(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  terminalControl?: LayerEnvelope,
) {
  const base = new Map<string, Record<string, unknown>>();
  const scoped = new Map<string, Record<string, unknown>>();
  const scopeInventory = validateScopeInventory(host.pipeline.inventory);
  const lineage = validateFinalAuthorityLineage(plan, journal);
  const observed = new Set<string>();
  const evidence: ValidatedFinalContextsBinding["layers"][number][] = [];
  for (const provider of [...host.providers].sort((a, b) =>
    a.id.localeCompare(b.id),
  ))
    await loadProviderLayers(
      host,
      provider,
      scopeInventory,
      lineage,
      {
        base,
        scoped,
        observed,
        evidence,
      },
      terminalControl,
    );
  if (observed.size !== lineage.size)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Upgrade validation omitted planned final layer evidence",
    );
  if (base.size !== host.providers.length)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Upgrade validation is missing a base layer",
    );
  sortEvidence(evidence);
  return { base, scoped, evidence };
}

function sortEvidence(
  evidence: ValidatedFinalContextsBinding["layers"][number][],
): void {
  evidence.sort((left, right) =>
    canonicalInternalJson([
      left.providerId,
      left.namespace,
      left.revision.storeId,
      left.revision.environment,
      left.revision.layer,
    ]).localeCompare(
      canonicalInternalJson([
        right.providerId,
        right.namespace,
        right.revision.storeId,
        right.revision.environment,
        right.revision.layer,
      ]),
    ),
  );
}

interface LayerLoadState {
  readonly base: Map<string, Record<string, unknown>>;
  readonly scoped: Map<string, Record<string, unknown>>;
  readonly observed: Set<string>;
  readonly evidence: ValidatedFinalContextsBinding["layers"][number][];
}

async function loadProviderLayers(
  host: ConfigServiceController,
  provider: ConfigServiceController["providers"][number],
  scopeInventory: ReturnType<typeof validateScopeInventory>,
  lineage: ReturnType<typeof validateFinalAuthorityLineage>,
  state: LayerLoadState,
  terminalControl?: LayerEnvelope,
): Promise<void> {
  if (!provider.authority)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Upgrade validation requires complete provider authority",
    );
  const inventory = providerInventorySchema.parse(
    await provider.authority.inventory(),
  );
  assertExactInventory(
    inventory.revisions.map((item) => item.layer),
    catalogLayers(host.providers, provider, scopeInventory),
  );
  for (const revision of [...inventory.revisions].sort((a, b) =>
    a.layer.localeCompare(b.layer),
  ))
    await loadLayer(host, provider, revision, lineage, state, terminalControl);
}

async function loadLayer(
  host: ConfigServiceController,
  provider: ConfigServiceController["providers"][number],
  revision: ProviderRevision,
  lineage: ReturnType<typeof validateFinalAuthorityLineage>,
  state: LayerLoadState,
  terminalControl?: LayerEnvelope,
): Promise<void> {
  if (!provider.authority)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Upgrade validation authority disappeared",
    );
  const envelope = await provider.authority.readLayer(revision.layer);
  if (!sameRevision(envelope, revision))
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Upgrade validation layer changed during authoritative read",
    );
  const key = finalLayerKey(provider.id, revision.layer);
  const expected = lineage.get(key);
  const capabilities = provider.authority.capabilities;
  if (!expected || !("namespace" in capabilities) || state.observed.has(key))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid planned final layer read",
    );
  if (provider === host.pipeline.controlProvider && terminalControl)
    assertTerminalControlLayer(expected.binding, envelope, terminalControl);
  else
    assertFinalLayerEvidence(
      expected,
      provider.id,
      capabilities.namespace,
      envelope,
      provider === host.pipeline.controlProvider,
    );
  state.observed.add(key);
  state.evidence.push({
    providerId: provider.id,
    namespace: capabilities.namespace,
    revision: getProviderRevision(envelope),
    contentDigest: expected.binding.finalDigest,
  });
  const target = revision.layer === provider.layer ? state.base : state.scoped;
  target.set(
    revision.layer === provider.layer ? provider.id : revision.layer,
    structuredClone(envelope.entries),
  );
}

function assertTerminalControlLayer(
  binding: InternalUpgradePlan["finalLayers"][number],
  envelope: LayerEnvelope,
  terminal: LayerEnvelope,
): void {
  if (
    !deepEqual(envelope, terminal) ||
    internalUpgradeLayerDigest(envelope.entries, binding.contentDomain) !==
      binding.finalDigest
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Terminal control application projection differs from activation evidence",
    );
}

function assertExactInventory(actual: string[], expected: string[]): void {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((layer) => !expected.includes(layer))
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Upgrade validation inventory differs from the bound scope catalog",
    );
}

function sameRevision(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return (
    left.storeId === right.storeId &&
    left.environment === right.environment &&
    left.layer === right.layer &&
    left.epoch === right.epoch &&
    left.sequence === right.sequence
  );
}

export function stepKey(step: InternalUpgradeStep): string {
  return parseCanonicalConfigPath(step.target.path).storageKey;
}

export function assertPrestate(
  step: InternalUpgradeStep,
  envelope: LayerEnvelope,
): void {
  if (!deepEqual(getProviderRevision(envelope), step.expectedRevision))
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Upgrade target revision changed",
    );
  if (
    rawTargetDigest(deepGet(envelope.entries, stepKey(step))) !== step.preDigest
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Upgrade target content changed",
    );
}

export function committedReceipt(
  step: InternalUpgradeStep,
  envelope: LayerEnvelope,
) {
  const receipt = envelope.lastCommit;
  if (!receipt || receipt.operationId !== step.id) return undefined;
  const mutation =
    step.mutation.action === "set"
      ? {
          action: "set" as const,
          key: stepKey(step),
          value: step.mutation.value,
        }
      : { action: "remove" as const, key: stepKey(step) };
  const digest = computeProviderMutationDigest({
    layer: step.target.layer,
    expectedRevision: receipt.previousRevision,
    operationId: step.id,
    mutation,
  });
  const value = deepGet(envelope.entries, stepKey(step));
  return receipt.mutationDigest === digest &&
    rawTargetDigest(value) === step.postDigest
    ? receipt
    : undefined;
}

export function exactPrestate(
  step: InternalUpgradeStep,
  envelope: LayerEnvelope,
): boolean {
  return (
    deepEqual(getProviderRevision(envelope), step.expectedRevision) &&
    rawTargetDigest(deepGet(envelope.entries, stepKey(step))) === step.preDigest
  );
}

function rawTargetDigest(value: unknown): string {
  return transitionDigest({
    absent: value === undefined,
    ...(value === undefined ? {} : { value }),
  });
}

export function samePlan(
  left: InternalUpgradePlan,
  right: InternalUpgradePlan,
): boolean {
  return canonicalInternalJson(left) === canonicalInternalJson(right);
}
