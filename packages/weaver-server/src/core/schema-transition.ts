import { createHash } from "node:crypto";
import { deepGet, parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalConfigurationSchema,
  type LayerEnvelope,
} from "@weaver-conf/config-types";
import {
  getProviderRevision,
  validateProviderEnvelope,
} from "@weaver-conf/storage-providers";
import { projectCanonicalRegistrations } from "./canonical-projection";
import type { ConfigServiceController } from "./config-service-controller";
import { assertCurrentJournalReceipt } from "./control-journal-lineage";
import { assertTransitionSources } from "./upgrade-source-validation";

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

export async function validateUpgradeRecoverySources(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  const { state } = await readRecoveryControl(host);
  assertRecoverySourceIdentity({ plan, state, journal });
  await assertTransitionSources(host, plan, journal, false);
}

export async function validateUpgradeRecoveryIdentity(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  requestedRunId = journal.runId,
): Promise<InternalConfiguration> {
  const state = await validateUpgradeRecoveryControl(
    host,
    plan,
    journal,
    requestedRunId,
  );
  assertRecoverySourceIdentity({ plan, state, journal });
  const projected = host.pipeline.contracts.prepared().configuration;
  for (const step of plan.steps)
    prepareTargetCatalog(host, projected, plan, step.target.path);
  return state;
}

export async function validateUpgradeRecoveryControl(
  host: ConfigServiceController,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  requestedRunId = journal.runId,
): Promise<InternalConfiguration> {
  const { state, envelope } = await readRecoveryControl(host);
  const selected = selectRawRecovery(state, requestedRunId);
  if (selected.journal.activation?.status !== "intent")
    assertCurrentJournalReceipt(envelope, selected.journal);
  host.authority.assertCapturedSnapshot(
    host.pipeline.controlProvider,
    envelope,
  );
  assertSelectedRecovery(selected, plan, journal, requestedRunId);
  return state;
}

async function readRecoveryControl(host: ConfigServiceController): Promise<{
  readonly state: InternalConfiguration;
  readonly envelope: LayerEnvelope;
}> {
  const control = host.pipeline.controlProvider;
  const raw = await control.authority?.readLayer(control.layer);
  const envelope = validateProviderEnvelope(raw);
  if (
    envelope.storeId !== host.pipeline.contracts.binding.storeId ||
    envelope.environment !== host.pipeline.contracts.binding.environment ||
    envelope.environment !== host.options.environment ||
    envelope.layer !== control.layer
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Recovery control authority binding changed",
    );
  const parsed = internalConfigurationSchema.safeParse(
    envelope.entries._weaver,
  );
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Recovery control authority is malformed",
      { issues: parsed.error.issues },
    );
  return { state: parsed.data, envelope };
}

interface SelectedRecovery {
  readonly journal: InternalRecoveryEnvelope;
  readonly plan: InternalUpgradePlan;
}

function selectRawRecovery(
  state: InternalConfiguration,
  runId: string,
): SelectedRecovery {
  const matches = Object.entries(state.upgrades.journal).filter(
    ([key, value]) => key === runId || value.runId === runId,
  );
  const rawJournal = state.upgrades.journal[runId];
  const rawPlan = rawJournal && state.upgrades.plans[rawJournal.planId];
  if (
    matches.length !== 1 ||
    !rawJournal ||
    rawJournal.runId !== runId ||
    !rawPlan
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Requested recovery input is missing from durable control authority",
    );
  return { journal: rawJournal, plan: rawPlan };
}

function assertSelectedRecovery(
  raw: SelectedRecovery,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  runId: string,
): void {
  const planMatches = raw.plan.id === plan.id && raw.journal.planId === plan.id;
  if (
    journal.runId !== runId ||
    !planMatches ||
    !sameCanonical(raw.plan, plan) ||
    !sameCanonical(raw.journal, journal)
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Projected recovery input differs from durable control authority",
    );
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalInternalJson(left) === canonicalInternalJson(right);
}

function assertRecoverySourceIdentity({
  plan,
  state,
  journal,
}: RecoverySourceIntent): void {
  if (
    plan.source.catalogDigest !== transitionDigest(state.catalog) ||
    plan.source.inventoryRevision !== state.scopeInventory.revision ||
    plan.source.infrastructureGeneration !==
      state.infrastructure.activeGeneration ||
    journal.infrastructureGeneration !== state.infrastructure.activeGeneration
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Recovery catalog, inventory, or generation changed",
    );
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
interface RecoverySourceIntent {
  readonly plan: InternalUpgradePlan;
  readonly state: InternalConfiguration;
  readonly journal: InternalRecoveryEnvelope;
}

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

function assertSourceIdentity({
  plan,
  state,
  journal,
}: RecoverySourceIntent): void {
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

function sameRevisionIdentity(
  left: import("@weaver-conf/config-types").ProviderRevision,
  right: import("@weaver-conf/config-types").ProviderRevision,
): boolean {
  return (
    canonicalInternalJson({ ...left, sequence: right.sequence }) ===
    canonicalInternalJson(right)
  );
}
