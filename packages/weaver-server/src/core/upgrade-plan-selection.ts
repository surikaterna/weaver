import {
  compileInternalRegistrations,
  deepEqual,
} from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  type InternalUpgradePlanRequest,
  internalUpgradePlanSchema,
  sha256Hex,
} from "@weaver-conf/config-types";
import { assertSupportedSourceBuiltinCatalog } from "./builtin-catalog";
import { hostForControl } from "./config-service-internal";
import type { WeaverConfigService } from "./config-service-types";
import { assertInstalledPlanSemantics } from "./upgrade-installed-plan-semantics";
import {
  assertInstalledPlanBindings,
  assertInstalledPlanReceipt,
  revalidateInstalledPlanSource,
} from "./upgrade-installed-plan-source";
import { planRuntimeUpgrade } from "./upgrade-planner";
import { collectUpgradePlanningSnapshot } from "./upgrade-planning-snapshot";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

type Snapshot = Awaited<ReturnType<typeof collectUpgradePlanningSnapshot>>;

export interface InstalledUpgradeSelection {
  readonly plan: InternalUpgradePlan;
  readonly revalidate: (journal: InternalRecoveryEnvelope) => Promise<void>;
}

export async function prepareInstalledUpgradePlan(
  runtime: UpgradeRuntimeHost,
  request: InternalUpgradePlanRequest,
): Promise<InstalledUpgradeSelection | undefined> {
  const selected = await selectInstalledUpgradePlan(
    runtime.configService,
    request,
  );
  if (!selected) return undefined;
  await runtime.enterMaintenance();
  const reselected = await selectInstalledUpgradePlan(
    runtime.configService,
    request,
  );
  if (!reselected || !deepEqual(selected.plan, reselected.plan))
    stale("Upgrade authority changed before persistence");
  return selected;
}

/** Selects a protected plan only when its complete source authority is current. */
async function selectInstalledUpgradePlan(
  service: WeaverConfigService,
  request: InternalUpgradePlanRequest,
): Promise<InstalledUpgradeSelection | undefined> {
  const expected = await planRuntimeUpgrade(service, request);
  const snapshot = await collectUpgradePlanningSnapshot(service);
  if (!snapshot.stable)
    stale("Upgrade authority changed during plan selection");
  const raw = await readRawPlans(service, snapshot);
  const plans = parsePlanRecords(raw.records);
  const candidates = plans.filter((plan) =>
    requestIdentityMatches(request, plan),
  );
  if (!candidates.length) return undefined;
  if (request.dispositions?.length)
    stale("Installed plan does not retain exact disposition semantics");
  if (expected.result.status !== "ready")
    stale("Normal planner did not authorize this semantic transition");
  for (const plan of candidates)
    await validateCandidate(
      service,
      snapshot,
      request,
      expected.result.plan,
      plan,
    );
  if (candidates.length !== 1)
    stale("Installed upgrade plan selection is ambiguous");
  const match = candidates[0];
  if (!match) stale("Installed upgrade plan selection is ambiguous");
  assertInstalledPlanReceipt(snapshot, match, raw.control);
  return {
    plan: match,
    revalidate: (journal) =>
      revalidateInstalledPlanSource(service, match, journal),
  };
}

async function readRawPlans(service: WeaverConfigService, snapshot: Snapshot) {
  const host = hostForControl(service);
  const provider = host.pipeline.controlProvider;
  const envelope = await provider.authority?.readLayer(provider.layer);
  if (!envelope || host.authority.revision() !== snapshot.authorityRevision)
    stale("Control authority changed during plan selection");
  const source = snapshot.providers
    .find((item) => item.providerId === provider.id)
    ?.layers.find((item) => item.revision.layer === provider.layer)?.revision;
  if (!source || !sameRevision(source, envelope))
    stale("Control authority changed during plan selection");
  const root = envelope.entries._weaver;
  if (
    !isRecord(root) ||
    !isRecord(root.upgrades) ||
    !isRecord(root.upgrades.plans)
  )
    invalid("Protected upgrade plan storage is malformed");
  return { records: root.upgrades.plans, control: envelope };
}

function parsePlanRecords(records: Readonly<Record<string, unknown>>) {
  return Object.entries(records).map(([recordId, value]) => {
    const parsed = internalUpgradePlanSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== recordId)
      invalid("Protected upgrade plan record is malformed");
    return parsed.data;
  });
}

async function validateCandidate(
  service: WeaverConfigService,
  snapshot: Snapshot,
  request: InternalUpgradePlanRequest,
  expected: InternalUpgradePlan,
  plan: InternalUpgradePlan,
): Promise<void> {
  assertCanonicalPlanId(plan);
  assertRequestBindings(snapshot, request, plan);
  assertInstalledPlanBindings(snapshot, plan);
  await assertInstalledPlanSemantics(service, snapshot, expected, plan);
}

function requestIdentityMatches(
  request: InternalUpgradePlanRequest,
  plan: InternalUpgradePlan,
): boolean {
  return (
    request.sourceCatalogDigest === plan.source.catalogDigest &&
    request.inventoryRevision === plan.source.inventoryRevision &&
    request.infrastructureGeneration === plan.source.infrastructureGeneration &&
    deepEqual(request.target, plan.target)
  );
}

function assertCanonicalPlanId(plan: InternalUpgradePlan): void {
  const { id: _id, ...body } = plan;
  if (plan.id !== digest(body))
    invalid("Protected upgrade plan identity is invalid");
}

function assertRequestBindings(
  snapshot: Snapshot,
  request: InternalUpgradePlanRequest,
  plan: InternalUpgradePlan,
): void {
  const state = snapshot.configuration;
  const targetCatalog = { registrations: request.target.registrations ?? {} };
  const contexts = [
    [],
    ...Object.values(state.scopeInventory.contexts).map(
      (item) => item.scopePath,
    ),
  ].sort((a, b) =>
    canonicalInternalJson(a).localeCompare(canonicalInternalJson(b)),
  );
  assertSupportedSourceBuiltinCatalog(state.format.builtinCatalog);
  assertSupportedSourceBuiltinCatalog(
    plan.target.builtinCatalog ?? state.format.builtinCatalog,
  );
  compileInternalRegistrations(targetCatalog);
  if (
    request.expectedAuthorityRevision !== snapshot.authorityRevision ||
    request.sourceCatalogDigest !== digest(state.catalog) ||
    request.sourceCatalogDigest !== plan.source.catalogDigest ||
    request.inventoryRevision !== state.scopeInventory.revision ||
    request.inventoryRevision !== plan.source.inventoryRevision ||
    request.infrastructureGeneration !==
      state.infrastructure.activeGeneration ||
    plan.source.infrastructureGeneration !==
      state.infrastructure.activeGeneration ||
    (request.target.infrastructureGeneration !== undefined &&
      request.target.infrastructureGeneration !==
        state.infrastructure.activeGeneration) ||
    request.target.catalogDigest !== digest(targetCatalog) ||
    !deepEqual(plan.target, request.target) ||
    !deepEqual(plan.contexts, contexts)
  )
    stale("Installed upgrade plan request binding is stale");
}

function digest(value: unknown): string {
  return sha256Hex(canonicalInternalJson(value));
}

function sameRevision(
  left: {
    storeId: string;
    environment: string;
    layer: string;
    epoch: string;
    sequence: string;
  },
  right: typeof left,
): boolean {
  return (
    left.storeId === right.storeId &&
    left.environment === right.environment &&
    left.layer === right.layer &&
    left.epoch === right.epoch &&
    left.sequence === right.sequence
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stale(message: string): never {
  throw createWeaverError("REVISION_CONFLICT", message);
}

function invalid(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}
