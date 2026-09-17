import {
  type ConfigurationStorageProvider,
  canonicalInternalJson,
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalUpgradeLayerDigest,
  type ProviderRevision,
  providerInventorySchema,
} from "@weaver-conf/config-types";
import type { ConfigServiceController } from "./config-service-controller";

export async function assertTransitionSources(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  skipIntentDigest = true,
): Promise<void> {
  const control = host.pipeline.controlProvider;
  if (
    Object.keys(host.layerData.get(control.id) ?? {}).some(
      (key) => key !== "_weaver",
    )
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Repair requires an isolated control data layer",
    );
  for (const provider of host.providers) {
    if (provider === control) continue;
    await assertProviderSource(host, plan, journal, provider, skipIntentDigest);
  }
}

async function assertProviderSource(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  provider: ConfigurationStorageProvider,
  skipIntentDigest: boolean,
): Promise<void> {
  if (!provider.authority)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Repair sources require owned authority",
    );
  const inventory = providerInventorySchema.parse(
    await provider.authority.inventory(),
  );
  const original = plan.source.providerRevisions.find(
    (item) => item.providerId === provider.id,
  );
  const cursor = "cursor" in journal ? journal.cursor : undefined;
  assertSourceVector(
    provider.id,
    inventory.revisions,
    original?.revisions,
    cursor,
  );
  for (const revision of inventory.revisions)
    await assertLayerSource(
      host,
      plan,
      journal,
      provider,
      revision,
      original?.revisions,
      cursor,
      skipIntentDigest,
    );
}

function assertSourceVector(
  providerId: string,
  actual: readonly ProviderRevision[],
  original: readonly ProviderRevision[] | undefined,
  cursor: InternalRecoveryEnvelope["sourceRevisions"],
): void {
  const expected = original?.map(
    (revision) => findRevision(cursor, providerId, revision.layer) ?? revision,
  );
  if (!expected || canonical(expected) !== canonical(actual))
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Repair source vector changed or is incomplete",
    );
}

async function assertLayerSource(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  provider: ConfigurationStorageProvider,
  revision: ProviderRevision,
  original: readonly ProviderRevision[] | undefined,
  cursor: InternalRecoveryEnvelope["sourceRevisions"],
  skipIntentDigest: boolean,
): Promise<void> {
  if (isControlRevision(journal, revision)) return;
  const source = original?.find((item) => item.layer === revision.layer);
  const current = findRevision(cursor, provider.id, revision.layer);
  if (
    source &&
    current &&
    revision.sequence !== source.sequence &&
    current.sequence !== source.sequence
  )
    return;
  const digest = plan.source.dataDigests.find(
    (item) =>
      item.providerId === provider.id &&
      item.layer === revision.layer &&
      item.storeId === revision.storeId,
  );
  if (!digest) return failDigest(provider.id, revision.layer);
  if (skipIntentDigest && hasIntent(journal, provider.id, revision.layer))
    return;
  const snapshot = await host.authority.load(provider, revision.layer);
  if (
    digest.digest !==
    internalUpgradeLayerDigest(snapshot.entries, digest.contentDomain)
  )
    failDigest(provider.id, revision.layer);
}

function findRevision(
  entries: InternalRecoveryEnvelope["sourceRevisions"],
  providerId: string,
  layer: string,
): ProviderRevision | undefined {
  return entries?.find(
    (entry) =>
      entry.providerId === providerId && entry.revision.layer === layer,
  )?.revision;
}

function isControlRevision(
  journal: InternalRecoveryEnvelope,
  revision: ProviderRevision,
): boolean {
  return (
    journal.control?.revision.storeId === revision.storeId &&
    journal.control.revision.layer === revision.layer
  );
}

function hasIntent(
  journal: InternalRecoveryEnvelope,
  providerId: string,
  layer: string,
): boolean {
  return journal.steps.some(
    (step) =>
      step.status === "intent" &&
      step.target.providerId === providerId &&
      step.target.layer === layer,
  );
}

function canonical(items: readonly unknown[]): string {
  return items.map(canonicalInternalJson).sort().join("\n");
}

function failDigest(providerId: string, layer: string): never {
  throw createWeaverError(
    "REVISION_CONFLICT",
    `Repair source digest changed or is incomplete: ${providerId}/${layer}`,
  );
}
