import { deepEqual } from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalConfigurationSchema,
  type LayerEnvelope,
  type ProviderRevision,
} from "@weaver-conf/config-types";
import { runMaintenanceOperation } from "./config-service-internal";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

export interface TerminalControlSnapshot {
  readonly state: InternalConfiguration;
  readonly plan: InternalUpgradePlan;
  readonly envelope: LayerEnvelope;
  readonly providerId: string;
  readonly namespace: string;
}

export async function readTerminalControlSnapshot(
  runtime: UpgradeRuntimeHost,
  journal: InternalRecoveryEnvelope,
): Promise<TerminalControlSnapshot> {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const provider = host.pipeline.controlProvider;
    const capabilities = provider.authority?.capabilities;
    if (!provider.authority || !capabilities || !("namespace" in capabilities))
      return failAuthority();
    const envelope = await provider.authority.readLayer(provider.layer);
    const parsed = internalConfigurationSchema.safeParse(
      envelope.entries._weaver,
    );
    if (!parsed.success) return failAuthority();
    const state = parsed.data;
    const durableJournal = state.upgrades.journal[journal.runId];
    const plan = state.upgrades.plans[journal.planId];
    if (!durableJournal || !plan || !deepEqual(durableJournal, journal))
      return failAuthority();
    validateIdentity(
      provider.id,
      capabilities.namespace,
      envelope,
      plan,
      journal,
    );
    return {
      state,
      plan,
      envelope,
      providerId: provider.id,
      namespace: capabilities.namespace,
    };
  });
}

export async function assertTerminalAuthorityUnchanged(
  runtime: UpgradeRuntimeHost,
  snapshot: TerminalControlSnapshot,
): Promise<void> {
  await runMaintenanceOperation(runtime.configService, async (host) => {
    const provider = host.pipeline.controlProvider;
    const capabilities = provider.authority?.capabilities;
    if (
      provider.id !== snapshot.providerId ||
      !provider.authority ||
      !capabilities ||
      !("namespace" in capabilities) ||
      capabilities.namespace !== snapshot.namespace
    )
      return failAuthority();
    const current = await provider.authority.readLayer(provider.layer);
    if (
      !internalConfigurationSchema.safeParse(current.entries._weaver).success ||
      !sameRevision(current, snapshot.envelope) ||
      canonicalInternalJson(current.entries._weaver) !==
        canonicalInternalJson(snapshot.envelope.entries._weaver)
    )
      failAuthority();
  });
}

export function assertCachedTerminalState(
  cached: unknown,
  snapshot: TerminalControlSnapshot,
): void {
  if (!deepEqual(cached, snapshot.state))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Cached control state does not match durable terminal authority",
    );
}

function validateIdentity(
  providerId: string,
  namespace: string,
  envelope: LayerEnvelope,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): void {
  const binding = journal.control;
  if (!binding || providerId !== binding.providerId) failAuthority();
  const planned = plan.source.providerRevisions
    .find((source) => source.providerId === providerId)
    ?.revisions.find((revision) => revision.layer === binding.revision.layer);
  if (
    !planned ||
    !deepEqual(planned, binding.revision) ||
    !sameAuthority(envelope, binding.revision) ||
    BigInt(envelope.sequence) < BigInt(binding.revision.sequence) ||
    !matchesActivationAuthority(providerId, namespace, envelope, journal) ||
    !matchesPlanNamespace(providerId, namespace, plan)
  )
    failAuthority();
}

function matchesActivationAuthority(
  providerId: string,
  namespace: string,
  envelope: LayerEnvelope,
  journal: InternalRecoveryEnvelope,
): boolean {
  const activation = journal.activation;
  if (!activation || activation.status === "pending") return true;
  const revision = activation.control.revision;
  const latest =
    activation.status === "complete" ? activation.receipt.revision : revision;
  return (
    activation.control.providerId === providerId &&
    activation.control.namespace === namespace &&
    sameAuthority(envelope, revision) &&
    sameAuthority(envelope, latest) &&
    BigInt(envelope.sequence) >= BigInt(latest.sequence)
  );
}

function matchesPlanNamespace(
  providerId: string,
  namespace: string,
  plan: InternalUpgradePlan,
): boolean {
  return plan.steps
    .filter((step) => step.target.providerId === providerId)
    .every((step) => step.target.namespace === namespace);
}

function sameAuthority(left: ProviderRevision, right: ProviderRevision) {
  return (
    left.storeId === right.storeId &&
    left.environment === right.environment &&
    left.layer === right.layer &&
    left.epoch === right.epoch
  );
}

function sameRevision(left: ProviderRevision, right: ProviderRevision) {
  return sameAuthority(left, right) && left.sequence === right.sequence;
}

function failAuthority(): never {
  throw createWeaverError(
    "VALIDATION_ERROR",
    "Terminal control authority is missing, malformed, or divergent",
  );
}
