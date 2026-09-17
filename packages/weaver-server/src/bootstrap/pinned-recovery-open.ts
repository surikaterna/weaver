import { deepEqual } from "@weaver-conf/config-engine";
import {
  type BootstrapSeed,
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalConfigurationSchema,
  internalUpgradePlanSchema,
  type LayerEnvelope,
  layerCommitRequestSchema,
  type ProviderRevision,
  providerInventorySchema,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import {
  assertSupportedSourceBuiltinCatalog,
  readBuiltinRecoveryEnvelope,
} from "../core/builtin-catalog";
import {
  validateBuiltinPlanBindings,
  validateJournalPlanBinding,
} from "../core/builtin-plan-validation";
import { trustedProviderDefinition } from "../core/provider-definition-binding";
import { transitionDigest } from "../core/schema-transition";
import { CONTROL_LAYER } from "./compile-layout";
import type { ProviderResource } from "./provider-resources";
import { bootstrapDigest } from "./seed-trust";

export interface PinnedRecoveryOpen {
  readonly configuration: InternalConfiguration;
  readonly journal: InternalRecoveryEnvelope;
  readonly plan: InternalUpgradePlan;
}

interface AuthorizedPinnedRecovery {
  readonly providerId: string;
  readonly namespace: string;
  readonly envelope: LayerEnvelope;
  readonly configuration: InternalConfiguration;
}

const authorized = new WeakMap<object, AuthorizedPinnedRecovery>();

export async function inspectPinnedRecovery(
  seed: BootstrapSeed,
  resource: ProviderResource,
): Promise<PinnedRecoveryOpen | undefined> {
  try {
    return await inspect(seed, resource);
  } catch (error) {
    if (isProtectedError(error)) throw error;
    throw invalidEvidence();
  }
}

async function inspect(
  seed: BootstrapSeed,
  resource: ProviderResource,
): Promise<PinnedRecoveryOpen | undefined> {
  const authority = resource.provider.authority;
  const capabilities = authority?.capabilities;
  if (!authority || !capabilities || !("namespace" in capabilities))
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Seed recovery authority is unavailable",
    );
  const envelope = await authority.readLayer(CONTROL_LAYER);
  const raw = record(envelope.entries._weaver);
  const upgrades = record(raw?.upgrades);
  const journals = record(upgrades?.journal);
  if (!raw || !upgrades || !journals || !Object.keys(journals).length)
    return undefined;
  const selected = selectJournal(journals);
  if (!selected) return undefined;
  const plans = record(upgrades.plans);
  const plan = internalUpgradePlanSchema.parse(plans?.[selected.planId]);
  if (journals[selected.runId] === undefined || plans?.[plan.id] === undefined)
    throw invalidEvidence();
  assertCatalogPins(selected, plan);
  const durable = internalConfigurationSchema.parse(raw);
  const configuration = recoveryConfiguration(durable, selected, plan);
  assertSeedBinding(seed, envelope, configuration);
  validateJournalPlanBinding(configuration, plan, selected);
  assertControlTip(resource.provider.id, envelope, selected);
  const pinned = Object.freeze({ configuration, journal: selected, plan });
  authorized.set(pinned, {
    providerId: resource.provider.id,
    namespace: capabilities.namespace,
    envelope: structuredClone(envelope),
    configuration: structuredClone(configuration),
  });
  return pinned;
}

export async function consumePinnedRecoveryContext(
  value: unknown,
  providers: readonly import("@weaver-conf/config-types").ConfigurationStorageProvider[],
): Promise<InternalConfiguration> {
  if (value === null || typeof value !== "object") throw invalidEvidence();
  const evidence = authorized.get(value);
  if (!evidence) throw invalidEvidence();
  const provider = providers.find((item) => item.id === evidence.providerId);
  const capabilities = provider?.authority?.capabilities;
  if (
    !provider?.authority ||
    !capabilities ||
    !("namespace" in capabilities) ||
    capabilities.namespace !== evidence.namespace ||
    !samePinnedEnvelope(
      await provider.authority.readLayer(evidence.envelope.layer),
      evidence.envelope,
    )
  )
    throw invalidEvidence();
  authorized.delete(value);
  return structuredClone(evidence.configuration);
}

function samePinnedEnvelope(
  left: LayerEnvelope,
  right: LayerEnvelope,
): boolean {
  return (
    left.storageFormat === right.storageFormat &&
    sameRevision(left, right) &&
    canonicalInternalJson(left.lastCommit ?? null) ===
      canonicalInternalJson(right.lastCommit ?? null) &&
    canonicalInternalJson(left.entries) === canonicalInternalJson(right.entries)
  );
}

function selectJournal(
  journals: Readonly<Record<string, unknown>>,
): InternalRecoveryEnvelope | undefined {
  const parsed = Object.entries(journals).map(([id, value]) => {
    const journal = readBuiltinRecoveryEnvelope(value);
    if (journal.runId !== id) throw invalidEvidence();
    return journal;
  });
  const active = parsed.filter((journal) => !isTerminal(journal));
  if (active.length > 1) throw invalidEvidence();
  if (active.length === 1) return active[0];
  return parsed.length === 1 ? parsed[0] : undefined;
}

function recoveryConfiguration(
  raw: InternalConfiguration,
  journal: InternalRecoveryEnvelope,
  plan: InternalUpgradePlan,
): InternalConfiguration {
  const rawCatalog = raw.catalog;
  const activated = activationStarted(journal);
  const catalog =
    activated && plan.target.registrations
      ? { registrations: plan.target.registrations }
      : rawCatalog;
  const expectedDigest = activated
    ? plan.target.catalogDigest
    : plan.source.catalogDigest;
  if (transitionDigest(catalog) !== expectedDigest) throw invalidEvidence();
  return internalConfigurationSchema.parse({
    ...raw,
    format: {
      ...raw.format,
      builtinCatalog: activated ? journal.target : journal.source,
    },
    catalog,
    infrastructure: sourceInfrastructure(raw, plan),
    upgrades: {
      plans: { [plan.id]: plan },
      journal: { [journal.runId]: journal },
    },
  });
}

function sourceInfrastructure(
  raw: InternalConfiguration,
  plan: InternalUpgradePlan,
) {
  const infrastructure = raw.infrastructure;
  const generations = infrastructure.generations;
  const source = generations[plan.source.infrastructureGeneration];
  if (!source) throw invalidEvidence();
  const selected = [
    plan.source.infrastructureGeneration,
    ...(plan.target.infrastructureGeneration
      ? [plan.target.infrastructureGeneration]
      : []),
  ];
  const retained = Object.fromEntries(
    selected.map((id) => {
      const generation = generations[id];
      if (!generation) throw invalidEvidence();
      return [id, generation];
    }),
  );
  return {
    ...infrastructure,
    activeGeneration: plan.source.infrastructureGeneration,
    generations: retained,
  };
}

function assertCatalogPins(
  journal: InternalRecoveryEnvelope,
  plan: InternalUpgradePlan,
): void {
  assertSupportedSourceBuiltinCatalog(journal.source);
  assertSupportedSourceBuiltinCatalog(journal.target);
  const target = plan.target.builtinCatalog ?? journal.source;
  if (
    journal.planId !== plan.id ||
    journal.infrastructureGeneration !== plan.source.infrastructureGeneration ||
    !deepEqual(journal.target, target)
  )
    throw invalidEvidence();
}

function assertSeedBinding(
  seed: BootstrapSeed,
  envelope: LayerEnvelope,
  state: InternalConfiguration,
): void {
  if (
    envelope.environment !== seed.environment ||
    state.format.storeId !== envelope.storeId ||
    state.format.environment !== seed.environment ||
    state.format.initialization !== "initialized" ||
    state.format.initializationIntent?.seedDigest !== bootstrapDigest(seed)
  )
    throw invalidEvidence();
}

function assertControlTip(
  providerId: string,
  envelope: LayerEnvelope,
  journal: InternalRecoveryEnvelope,
): void {
  const control = journal.control;
  if (
    !control ||
    control.providerId !== providerId ||
    !sameAuthority(envelope, control.revision) ||
    BigInt(envelope.sequence) < BigInt(control.revision.sequence)
  )
    throw invalidEvidence();
  if (journal.activation && journal.activation.status !== "pending") return;
  const previous = control.receipts.at(-1)?.revision ?? control.revision;
  const receipt = envelope.lastCommit;
  const request = layerCommitRequestSchema.parse({
    layer: envelope.layer,
    expectedRevision: previous,
    operationId: control.operationId,
    mutation: {
      action: "set",
      key: `_weaver.upgrades.journal.${journal.runId}`,
      value: journal,
    },
  });
  if (
    !receipt ||
    receipt.operationId !== control.operationId ||
    !deepEqual(receipt.previousRevision, previous) ||
    !sameRevision(receipt.revision, envelope) ||
    receipt.mutationDigest !== computeProviderMutationDigest(request)
  )
    throw invalidEvidence();
}

export async function validatePinnedAuthorities(
  pinned: PinnedRecoveryOpen,
  resources: readonly ProviderResource[],
): Promise<void> {
  const authorities = await Promise.all(
    resources.map(async ({ provider }) => {
      const definition = trustedProviderDefinition(provider);
      const capabilities = provider.authority?.capabilities;
      if (
        !definition ||
        !provider.authority ||
        !capabilities ||
        !("namespace" in capabilities)
      )
        throw invalidEvidence();
      const inventory = providerInventorySchema.parse(
        await provider.authority.inventory(),
      );
      return {
        providerId: provider.id,
        definition,
        namespace: capabilities.namespace,
        revisions: inventory.revisions,
      };
    }),
  );
  validateBuiltinPlanBindings(pinned.configuration, pinned.plan, authorities);
}

function activationStarted(journal: InternalRecoveryEnvelope): boolean {
  return (
    journal.phase === "completed" ||
    journal.phase === "restart-required" ||
    (journal.activation !== undefined &&
      journal.activation.status !== "pending")
  );
}

function isTerminal(journal: InternalRecoveryEnvelope): boolean {
  return ["completed", "compensated", "restart-required"].includes(
    journal.phase,
  );
}

function sameAuthority(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return (
    left.storeId === right.storeId &&
    left.environment === right.environment &&
    left.layer === right.layer &&
    left.epoch === right.epoch
  );
}

function sameRevision(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return sameAuthority(left, right) && left.sequence === right.sequence;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
}

function isProtectedError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "UNSUPPORTED_AUTHORITY"
  );
}

function invalidEvidence() {
  return createWeaverError(
    "VALIDATION_ERROR",
    "Pinned recovery evidence is malformed, unsupported, or divergent",
  );
}
