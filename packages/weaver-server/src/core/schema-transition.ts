import { createHash } from "node:crypto";
import { deepGet, parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  type ConfigurationStorageProvider,
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type InternalUpgradePlan,
  internalUpgradeLayerDigest,
  providerInventorySchema,
} from "@weaver-conf/config-types";
import { getProviderRevision } from "@weaver-conf/storage-providers";
import { projectCanonicalRegistrations } from "./canonical-projection";
import type { ConfigServiceController } from "./config-service-controller";

export function transitionDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalInternalJson(value))
    .digest("hex");
}

function rawTargetDigest(value: unknown): string {
  return transitionDigest({
    absent: value === undefined,
    ...(value === undefined ? {} : { value }),
  });
}

/** Run-bound full-object repair. Does not activate a catalog or claim a cross-provider transaction. */
export async function prepareSchemaTransition(
  host: ConfigServiceController,
  runId: string,
  stepId: string,
  owner: string,
  expectedRevision: string,
) {
  const intent = repairIntent(host, runId, stepId, owner, expectedRevision);
  assertPlanIntent(intent);
  assertSourceIdentity(intent);
  await assertTransitionSources(host, intent.plan, intent.journal);
  return prepareRepairTarget(host, intent);
}

function repairIntent(
  host: ConfigServiceController,
  runId: string,
  stepId: string,
  owner: string,
  expectedRevision: string,
) {
  if (host.applicationActive || host.options.serviceMode !== "control")
    throw createWeaverError(
      "FORBIDDEN",
      "Repair requires isolated control admission",
    );
  if (expectedRevision !== host.authority.revision())
    throw createWeaverError("REVISION_CONFLICT", "Repair vector changed");
  const state = host.pipeline.contracts.prepared().configuration;
  const journal = state.upgrades.journal[runId];
  const plan = journal && state.upgrades.plans[journal.planId];
  const step = journal?.steps.find((item) => item.id === stepId);
  if (
    !journal ||
    journal.phase !== "applying" ||
    journal.owner !== owner ||
    !plan ||
    !step ||
    step.status !== "intent"
  )
    throw createWeaverError(
      "FORBIDDEN",
      "Repair requires this owner's persisted intent",
    );
  return { state, journal, plan, step };
}

type RepairIntent = ReturnType<typeof repairIntent>;

function assertPlanIntent({ plan, step }: RepairIntent): void {
  const planned = plan.steps.find((item) => item.id === step.id);
  if (
    !planned ||
    canonicalInternalJson(planned.target) !==
      canonicalInternalJson(step.target) ||
    canonicalInternalJson(planned.mutation) !==
      canonicalInternalJson(step.mutation) ||
    !sameRevisionIdentity(planned.expectedRevision, step.preRevision) ||
    BigInt(step.preRevision.sequence) <
      BigInt(planned.expectedRevision.sequence) ||
    planned.preDigest !== step.preDigest ||
    planned.postDigest !== step.postDigest
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Intent does not match its validated plan",
    );
}

function assertSourceIdentity({ plan, state, journal }: RepairIntent): void {
  if (
    plan.source.catalogDigest !== transitionDigest(state.catalog) ||
    plan.source.inventoryRevision !== state.scopeInventory.revision ||
    plan.source.infrastructureGeneration !==
      state.infrastructure.activeGeneration ||
    journal.infrastructureGeneration !== state.infrastructure.activeGeneration
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Repair catalog/inventory/generation changed",
    );
  if (
    canonicalInternalJson(journal.source) !==
      canonicalInternalJson(state.format.builtinCatalog) ||
    canonicalInternalJson(journal.target) !==
      canonicalInternalJson(
        plan.target.builtinCatalog ?? state.format.builtinCatalog,
      )
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Repair code-catalog references do not match",
    );
}

async function prepareRepairTarget(
  host: ConfigServiceController,
  { state, step, plan }: RepairIntent,
) {
  const provider = host.providers.find(
    (item) => item.id === step.target.providerId,
  );
  if (!provider?.authority || provider === host.pipeline.controlProvider)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Repair requires a separately owned application target",
    );
  const envelope = await provider.authority.readLayer(step.target.layer);
  if (
    canonicalInternalJson(getProviderRevision(envelope)) !==
    canonicalInternalJson(step.preRevision)
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Repair physical revision changed",
    );
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  if (step.target.path.startsWith("/_weaver"))
    throw createWeaverError(
      "FORBIDDEN",
      "Upgrade data steps cannot target protected metadata",
    );
  const raw = deepGet(envelope.entries, key);
  if (
    rawTargetDigest(raw) !== step.preDigest &&
    transitionDigest(raw) !== step.preDigest
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Repair raw pre-state changed",
    );
  const value = repairValue(step);
  const prepared = prepareTargetCatalog(host, state, plan, step.target.path);
  return {
    key,
    layer: step.target.layer,
    value,
    prepared,
    operationId: step.operationId,
  };
}

function repairValue(step: RepairIntent["step"]): Record<string, unknown> {
  const value =
    step.mutation.action === "set" ? step.mutation.value : undefined;
  if (!isRepairObject(value))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Repair requires a planned full object",
    );
  if (
    rawTargetDigest(value) !== step.postDigest &&
    transitionDigest(value) !== step.postDigest
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Repair post-state digest mismatch",
    );
  return value;
}

function isRepairObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function prepareTargetCatalog(
  host: ConfigServiceController,
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  path: string,
) {
  const target = structuredClone(state);
  if (plan.target.registrations)
    target.catalog.registrations = structuredClone(plan.target.registrations);
  if (transitionDigest(target.catalog) !== plan.target.catalogDigest)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Repair target catalog mismatch",
    );
  const prepared = host.pipeline.contracts.prepare(target);
  if (
    !projectCanonicalRegistrations(target.catalog).anchors.some(
      (anchor) => anchor.path === path,
    )
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Repair target is not a registered object anchor",
    );
  return prepared;
}

async function assertTransitionSources(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: RepairIntent["journal"],
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
    await assertProviderSource(host, plan, journal, provider);
  }
}

async function assertProviderSource(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: RepairIntent["journal"],
  provider: ConfigurationStorageProvider,
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
  const expected = original?.revisions.map(
    (revision) =>
      journal.cursor?.find(
        (entry) =>
          entry.providerId === provider.id &&
          entry.revision.layer === revision.layer,
      )?.revision ?? revision,
  );
  const canonical = (items: readonly unknown[]) =>
    items.map(canonicalInternalJson).sort().join("\n");
  if (!expected || canonical(expected) !== canonical(inventory.revisions))
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Repair source vector changed or is incomplete",
    );
  for (const revision of inventory.revisions) {
    const advanced = original?.revisions.find(
      (item) => item.layer === revision.layer,
    );
    const cursor = journal.cursor?.find(
      (entry) =>
        entry.providerId === provider.id &&
        entry.revision.layer === revision.layer,
    )?.revision;
    if (
      journal.control?.revision.storeId === revision.storeId &&
      journal.control.revision.layer === revision.layer
    )
      continue;
    if (
      advanced &&
      cursor &&
      (revision.sequence !== advanced.sequence ||
        cursor.sequence !== advanced.sequence)
    )
      continue;
    const digest = plan.source.dataDigests.find(
      (item) =>
        item.providerId === provider.id &&
        item.layer === revision.layer &&
        item.storeId === revision.storeId,
    );
    if (!digest)
      throw createWeaverError(
        "REVISION_CONFLICT",
        `Repair source digest changed or is incomplete: ${provider.id}/${revision.layer}`,
      );
    if (
      journal.steps.some(
        (step) =>
          step.status === "intent" &&
          step.target.providerId === provider.id &&
          step.target.layer === revision.layer,
      )
    )
      continue;
    const snapshot = await host.authority.load(provider, revision.layer);
    const actualDigest = internalUpgradeLayerDigest(
      snapshot.entries,
      digest.contentDomain,
    );
    if (digest.digest !== actualDigest)
      throw createWeaverError(
        "REVISION_CONFLICT",
        `Repair source digest changed or is incomplete: ${provider.id}/${revision.layer}`,
      );
  }
}

function sameRevisionIdentity(
  left: import("@weaver-conf/config-types").ProviderRevision,
  right: import("@weaver-conf/config-types").ProviderRevision,
): boolean {
  return (
    canonicalInternalJson({ ...left, sequence: right.sequence }) ===
    canonicalInternalJson(right)
  );
}
