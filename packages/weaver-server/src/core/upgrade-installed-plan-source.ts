import { deepEqual } from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type InternalProviderDefinition,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalConfigurationSchema,
  internalUpgradeLayerDigest,
  type LayerEnvelope,
  layerCommitRequestSchema,
  type ProviderRevision,
  providerInventorySchema,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import {
  type TrustedProviderAuthority,
  validateBuiltinPlanBindings,
  validateJournalPlanBinding,
} from "./builtin-plan-validation";
import type { ConfigServiceController } from "./config-service-controller";
import { runMaintenanceOperation } from "./config-service-internal";
import type { WeaverConfigService } from "./config-service-types";
import { assertCurrentJournalReceipt } from "./control-journal-lineage";
import type { collectUpgradePlanningSnapshot } from "./upgrade-planning-snapshot";
import { assertTransitionSources } from "./upgrade-source-validation";
import { assertJournalPlanBinding } from "./upgrade-step-recovery";

type Snapshot = Awaited<ReturnType<typeof collectUpgradePlanningSnapshot>>;

export function assertInstalledPlanBindings(
  snapshot: Snapshot,
  plan: InternalUpgradePlan,
): void {
  validateBuiltinPlanBindings(
    snapshot.configuration,
    plan,
    trustedAuthorities(snapshot),
  );
  assertProviderBindings(snapshot, plan);
}

export function assertInstalledPlanReceipt(
  snapshot: Snapshot,
  plan: InternalUpgradePlan,
  control: LayerEnvelope,
): void {
  assertLatestPlanReceipt(snapshot, plan, control);
}

export async function revalidateInstalledPlanSource(
  service: WeaverConfigService,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  await runMaintenanceOperation(service, async (host) => {
    const provider = host.pipeline.controlProvider;
    const envelope = await provider.authority?.readLayer(provider.layer);
    const state = internalConfigurationSchema.safeParse(
      envelope?.entries._weaver,
    );
    if (
      !envelope ||
      !state.success ||
      !deepEqual(state.data.upgrades.plans[plan.id], plan) ||
      !deepEqual(state.data.upgrades.journal[journal.runId], journal)
    )
      stale("Installed control plan or journal changed before data mutation");
    assertCurrentJournalReceipt(envelope, journal);
    assertJournalPlanBinding(plan, journal);
    validateJournalPlanBinding(state.data, plan, journal);
    await assertCurrentInfrastructure(host, state.data, plan);
    await assertTransitionSources(host, plan, journal, false);
  });
}

async function assertCurrentInfrastructure(
  host: ConfigServiceController,
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
): Promise<void> {
  const generationId = state.infrastructure.activeGeneration;
  if (
    generationId !== plan.source.infrastructureGeneration ||
    (plan.target.infrastructureGeneration !== undefined &&
      plan.target.infrastructureGeneration !== generationId)
  )
    stale("Installed infrastructure generation changed before data mutation");
  const admitted = host.pipeline.contracts.prepared().configuration;
  const expected = admitted.infrastructure.generations[generationId];
  const current = state.infrastructure.generations[generationId];
  if (!expected || !current || !deepEqual(current, expected))
    stale("Installed provider definitions changed before data mutation");
  validateBuiltinPlanBindings(
    state,
    plan,
    await currentAuthorities(host, expected),
  );
}

async function currentAuthorities(
  host: ConfigServiceController,
  generation: { readonly providers: readonly InternalProviderDefinition[] },
): Promise<TrustedProviderAuthority[]> {
  return Promise.all(
    host.providers.map(async (provider) => {
      const authority = provider.authority;
      const definition = generation.providers.find(
        (item) => item.id === provider.id,
      );
      if (!authority || !definition)
        stale("Installed provider authority changed before data mutation");
      const inventory = providerInventorySchema.parse(
        await authority.inventory(),
      );
      const capabilities = authority.capabilities;
      return {
        providerId: provider.id,
        definition,
        namespace:
          "namespace" in capabilities ? capabilities.namespace : provider.id,
        revisions: inventory.revisions,
      };
    }),
  );
}

function trustedAuthorities(snapshot: Snapshot): TrustedProviderAuthority[] {
  const generation =
    snapshot.configuration.infrastructure.generations[
      snapshot.configuration.infrastructure.activeGeneration
    ];
  if (!generation) stale("Active infrastructure generation is missing");
  return snapshot.providers.map((provider) => {
    const definition = generation.providers.find(
      (item) => item.id === provider.providerId,
    );
    if (!definition) stale("Installed plan provider definition is stale");
    return {
      providerId: provider.providerId,
      definition,
      namespace: provider.namespace,
      revisions: provider.layers.map((item) => item.revision),
    };
  });
}

function assertProviderBindings(snapshot: Snapshot, plan: InternalUpgradePlan) {
  const controlProvider = controlProviderId(snapshot);
  const actual = snapshot.providers.map((provider) => ({
    providerId: provider.providerId,
    revisions: provider.layers.map((item) =>
      provider.providerId === controlProvider
        ? (planRevision(plan, controlProvider, item.revision.layer) ??
          item.revision)
        : item.revision,
    ),
  }));
  if (canonicalSet(actual) !== canonicalSet(plan.source.providerRevisions))
    stale("Installed plan provider revisions are stale");
  for (const provider of snapshot.providers)
    for (const layer of provider.layers)
      assertLayerDigest(plan, provider, layer);
}

function assertLayerDigest(
  plan: InternalUpgradePlan,
  provider: Snapshot["providers"][number],
  layer: Snapshot["providers"][number]["layers"][number],
) {
  const source = plan.source.dataDigests.find(
    (item) =>
      item.providerId === provider.providerId &&
      item.layer === layer.revision.layer,
  );
  if (
    !source ||
    source.namespace !== provider.namespace ||
    source.storeId !== layer.revision.storeId ||
    source.digest !==
      internalUpgradeLayerDigest(layer.entries, source.contentDomain)
  )
    stale("Installed plan source digest is stale");
}

function assertLatestPlanReceipt(
  snapshot: Snapshot,
  plan: InternalUpgradePlan,
  control: LayerEnvelope,
) {
  const receipt = control.lastCommit;
  if (!receipt) stale("Installed plan control receipt is missing");
  const previous = verifiedPlanReceipt(plan, receipt, control);
  const expected = planRevision(
    plan,
    controlProviderId(snapshot),
    control.layer,
  );
  if (!expected || !sameRevision(previous, expected))
    stale("Installed plan control receipt is stale");
}

function verifiedPlanReceipt(
  plan: InternalUpgradePlan,
  receipt: NonNullable<LayerEnvelope["lastCommit"]>,
  current: ProviderRevision,
) {
  const request = layerCommitRequestSchema.parse({
    layer: current.layer,
    expectedRevision: receipt.previousRevision,
    operationId: receipt.operationId,
    mutation: {
      action: "set",
      key: `_weaver.upgrades.plans.${plan.id}`,
      value: plan,
    },
  });
  if (
    !sameRevision(receipt.revision, current) ||
    receipt.mutationDigest !== computeProviderMutationDigest(request)
  )
    stale("Installed plan control receipt is stale");
  return receipt.previousRevision;
}

function planRevision(
  plan: InternalUpgradePlan,
  providerId: string,
  layer: string,
) {
  return plan.source.providerRevisions
    .find((item) => item.providerId === providerId)
    ?.revisions.find((item) => item.layer === layer);
}

function controlProviderId(snapshot: Snapshot): string {
  const store = snapshot.configuration.format.storeId;
  const provider = snapshot.providers.find((item) =>
    item.layers.some((layer) => layer.revision.storeId === store),
  );
  if (!provider) stale("Control provider binding is missing");
  return provider.providerId;
}

function canonicalSet(value: readonly unknown[]): string {
  return value.map(canonicalInternalJson).sort().join("\n");
}

function sameRevision(left: ProviderRevision, right: ProviderRevision) {
  return (
    left.storeId === right.storeId &&
    left.environment === right.environment &&
    left.layer === right.layer &&
    left.epoch === right.epoch &&
    left.sequence === right.sequence
  );
}

function stale(message: string): never {
  throw createWeaverError("REVISION_CONFLICT", message);
}
