import { deepEqual } from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalConfigurationSchema,
  internalRecoveryEnvelopeSchema,
  type LayerCommitRequest,
  type LayerEnvelope,
  type ProviderRevision,
  type UpgradeActivation,
  type ValidatedFinalContextsBinding,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { runMaintenanceOperation } from "./config-service-internal";
import { finalContextsMatchPlan } from "./final-context-evidence";
import { transitionDigest } from "./schema-transition";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

type Intent = Extract<UpgradeActivation, { status: "intent" }>;
type Receipt = NonNullable<LayerEnvelope["lastCommit"]>;
export type ActivationEvidence =
  | { readonly status: "prestate" }
  | { readonly status: "poststate"; readonly receipt: Receipt }
  | { readonly status: "mismatch"; readonly reason: string };

export async function prepareActivationIntent(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  operationId: string,
  finalContexts: ValidatedFinalContextsBinding,
): Promise<InternalRecoveryEnvelope> {
  if (!finalContextsMatchPlan(finalContexts, plan, journal.runId))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Final context evidence does not belong to this upgrade run",
    );
  const snapshot = await readControl(runtime);
  const expected = nextRevision(snapshot.envelope);
  const terminal = hasRestartTarget(plan) ? "restart-required" : "completed";
  const base = intentFor(
    snapshot,
    plan,
    journal,
    operationId,
    expected,
    terminal,
    finalContexts,
  );
  const drafted = replaceActivation(journal, base);
  const prestate = replaceJournal(snapshot.state, drafted);
  const candidate = activationCandidate(prestate, plan, drafted);
  const withDigests = {
    ...base,
    prestateDigest: stateDigest(prestate, journal.runId),
    candidateDigest: stateDigest(candidate, journal.runId),
  };
  const bound = replaceActivation(journal, withDigests);
  const boundCandidate = activationCandidate(
    replaceJournal(snapshot.state, bound),
    plan,
    bound,
  );
  return replaceActivation(journal, {
    ...withDigests,
    mutationDigest: requestDigest(withDigests, boundCandidate, journal.runId),
  });
}

export async function inspectActivationEvidence(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): Promise<ActivationEvidence> {
  const activation = journal.activation;
  if (activation?.status !== "intent")
    return { status: "mismatch", reason: "intent is missing" };
  const snapshot = await readControl(runtime);
  const mismatch = bindingMismatch(snapshot, plan, journal, activation);
  if (mismatch) return { status: "mismatch", reason: mismatch };
  const receipt = snapshot.envelope.lastCommit;
  if (
    receipt &&
    exactReceipt(receipt, activation, snapshot.state, journal.runId)
  )
    return { status: "poststate", receipt };
  if (
    sameRevision(snapshot.envelope, activation.control.revision) &&
    stateDigest(snapshot.state, journal.runId) === activation.prestateDigest
  )
    return { status: "prestate" };
  return {
    status: "mismatch",
    reason: sameRevision(snapshot.envelope, activation.control.revision)
      ? "prestate digest mismatch"
      : "authoritative revision mismatch",
  };
}

export function activationCandidate(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): InternalConfiguration {
  const next = replaceJournal(state, journal);
  if (plan.target.registrations)
    next.catalog.registrations = structuredClone(plan.target.registrations);
  if (plan.target.builtinCatalog)
    next.format.builtinCatalog = structuredClone(plan.target.builtinCatalog);
  if (plan.target.infrastructureGeneration)
    next.infrastructure.activeGeneration = plan.target.infrastructureGeneration;
  return next;
}

export function completedPoststateMatches(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): boolean {
  const activation = journal.activation;
  if (activation?.status !== "complete") return false;
  const {
    receipt: _receipt,
    poststateDigest: _poststate,
    status: _status,
    ...fields
  } = activation;
  const intent: Intent = { ...fields, status: "intent" };
  const intentJournal = internalRecoveryEnvelopeSchema.parse({
    ...structuredClone(journal),
    phase: "verifying",
    activation: intent,
  });
  const candidate = activationCandidate(state, plan, intentJournal);
  return (
    stateDigest(candidate, journal.runId) === activation.candidateDigest &&
    exactReceipt(activation.receipt, activation, candidate, journal.runId)
  );
}

export function activationIntentMatchesPlan(
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): boolean {
  const activation = journal.activation;
  if (activation?.status !== "intent") return false;
  const target = activation.target;
  return (
    target.planId === plan.id &&
    target.catalogDigest === plan.target.catalogDigest &&
    deepEqual(
      target.builtinCatalog,
      plan.target.builtinCatalog ?? journal.source,
    ) &&
    target.sourceInfrastructureGeneration ===
      plan.source.infrastructureGeneration &&
    target.targetInfrastructureGeneration ===
      (plan.target.infrastructureGeneration ??
        plan.source.infrastructureGeneration) &&
    activation.terminal ===
      (hasRestartTarget(plan) ? "restart-required" : "completed") &&
    finalContextsMatchPlan(activation.finalContexts, plan, journal.runId)
  );
}

function intentFor(
  snapshot: ControlSnapshot,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  operationId: string,
  revision: ProviderRevision,
  terminal: "completed" | "restart-required",
  finalContexts: ValidatedFinalContextsBinding,
): Intent {
  return {
    status: "intent",
    operationId,
    control: {
      providerId: snapshot.providerId,
      namespace: snapshot.namespace,
      revision,
    },
    target: {
      planId: plan.id,
      catalogDigest: plan.target.catalogDigest,
      builtinCatalog: plan.target.builtinCatalog ?? journal.source,
      sourceInfrastructureGeneration: plan.source.infrastructureGeneration,
      targetInfrastructureGeneration:
        plan.target.infrastructureGeneration ??
        plan.source.infrastructureGeneration,
    },
    prestateDigest: zeroDigest(),
    mutationDigest: zeroDigest(),
    candidateDigest: zeroDigest(),
    finalContexts,
    terminal,
  };
}

interface ControlSnapshot {
  readonly providerId: string;
  readonly namespace: string;
  readonly envelope: LayerEnvelope;
  readonly state: InternalConfiguration;
}

async function readControl(
  runtime: UpgradeRuntimeHost,
): Promise<ControlSnapshot> {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const provider = host.pipeline.controlProvider;
    const capabilities = provider.authority?.capabilities;
    if (!provider.authority || !capabilities || !("namespace" in capabilities))
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Activation requires exact control authority",
      );
    const envelope = await provider.authority.readLayer(provider.layer);
    return {
      providerId: provider.id,
      namespace: capabilities.namespace,
      envelope,
      state: internalConfigurationSchema.parse(envelope.entries._weaver),
    };
  });
}

function bindingMismatch(
  snapshot: ControlSnapshot,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  activation: Intent,
): string | undefined {
  const target = activation.target;
  const expectedTerminal = hasRestartTarget(plan)
    ? "restart-required"
    : "completed";
  const candidate = activationCandidate(snapshot.state, plan, journal);
  if (activation.control.providerId !== snapshot.providerId)
    return "provider mismatch";
  if (activation.control.namespace !== snapshot.namespace)
    return "namespace mismatch";
  if (activation.control.revision.layer !== snapshot.envelope.layer)
    return "layer mismatch";
  if (target.planId !== plan.id) return "plan mismatch";
  if (target.catalogDigest !== plan.target.catalogDigest)
    return "catalog digest mismatch";
  if (
    !deepEqual(
      target.builtinCatalog,
      plan.target.builtinCatalog ?? journal.source,
    )
  )
    return "built-in target mismatch";
  if (
    target.sourceInfrastructureGeneration !==
    plan.source.infrastructureGeneration
  )
    return "source generation mismatch";
  if (
    target.targetInfrastructureGeneration !==
    (plan.target.infrastructureGeneration ??
      plan.source.infrastructureGeneration)
  )
    return "target generation mismatch";
  if (activation.terminal !== expectedTerminal) return "terminal mismatch";
  if (!finalContextsMatchPlan(activation.finalContexts, plan, journal.runId))
    return "final context binding mismatch";
  if (
    activation.mutationDigest !==
    requestDigest(activation, candidate, journal.runId)
  )
    return "mutation digest mismatch";
  if (activation.candidateDigest !== stateDigest(candidate, journal.runId))
    return "candidate digest mismatch";
  return undefined;
}

function exactReceipt(
  receipt: Receipt,
  activation: Intent | Extract<UpgradeActivation, { status: "complete" }>,
  candidate: InternalConfiguration,
  runId: string,
): boolean {
  const request = commitRequest(activation, candidate);
  return (
    receipt.operationId === activation.operationId &&
    deepEqual(receipt.previousRevision, activation.control.revision) &&
    sameAuthority(receipt.previousRevision, receipt.revision) &&
    isNext(receipt.previousRevision.sequence, receipt.revision.sequence) &&
    receipt.mutationDigest === computeProviderMutationDigest(request) &&
    stateDigest(candidate, runId) === activation.candidateDigest
  );
}

function requestDigest(
  activation: Intent,
  candidate: InternalConfiguration,
  runId: string,
) {
  return computeProviderMutationDigest(
    commitRequest(activation, normalizeState(candidate, runId)),
  );
}

function commitRequest(
  activation: Pick<Intent, "operationId" | "control">,
  candidate: InternalConfiguration,
): LayerCommitRequest {
  return {
    layer: activation.control.revision.layer,
    expectedRevision: activation.control.revision,
    operationId: activation.operationId,
    mutation: {
      action: "set",
      key: "_weaver",
      value: JSON.parse(canonicalInternalJson(candidate)),
    },
  };
}

function stateDigest(state: InternalConfiguration, runId: string): string {
  return transitionDigest(normalizeState(state, runId));
}

function normalizeState(state: InternalConfiguration, runId?: string) {
  const value = structuredClone(state);
  if (!runId) return value;
  const activation = value.upgrades.journal[runId]?.activation;
  if (activation && activation.status !== "pending") {
    activation.prestateDigest = zeroDigest();
    activation.mutationDigest = zeroDigest();
    activation.candidateDigest = zeroDigest();
  }
  return value;
}

function replaceJournal(
  state: InternalConfiguration,
  journal: InternalRecoveryEnvelope,
) {
  const next = structuredClone(state);
  next.upgrades.journal[journal.runId] = structuredClone(journal);
  return next;
}

function replaceActivation(
  journal: InternalRecoveryEnvelope,
  activation: UpgradeActivation,
): InternalRecoveryEnvelope {
  return internalRecoveryEnvelopeSchema.parse({
    ...structuredClone(journal),
    activation,
  });
}

function nextRevision(revision: ProviderRevision): ProviderRevision {
  return {
    storeId: revision.storeId,
    environment: revision.environment,
    layer: revision.layer,
    epoch: revision.epoch,
    sequence: (BigInt(revision.sequence) + 1n).toString(),
  };
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

function sameAuthority(left: ProviderRevision, right: ProviderRevision) {
  return deepEqual({ ...left, sequence: right.sequence }, right);
}

function isNext(previous: string, next: string) {
  return BigInt(next) === BigInt(previous) + 1n;
}

function hasRestartTarget(plan: InternalUpgradePlan) {
  return !!(plan.target.builtinCatalog || plan.target.infrastructureGeneration);
}

function zeroDigest() {
  return "0".repeat(64);
}
