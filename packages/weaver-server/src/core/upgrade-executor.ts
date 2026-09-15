import { randomUUID } from "node:crypto";
import { deepGet } from "@weaver-conf/config-engine";
import {
  BUILTIN_CATALOG_REFERENCE,
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalRecoveryEnvelopeSchema,
  type LayerEnvelope,
  type UpgradeApplyRequest,
  upgradeApplyRequestSchema,
  type WriteResult,
} from "@weaver-conf/config-types";
import {
  inspectActivationEvidence,
  prepareActivationIntent,
} from "./activation-recovery";
import {
  controlProjection,
  runMaintenanceOperation,
} from "./config-service-internal";
import type { createControlService } from "./control-service";
import type { ValidatedFinalContexts } from "./final-context-evidence";
import {
  type InternalUpgradeExecutionResult,
  internalUpgradeResult,
} from "./public-upgrade-status";
import { transitionDigest } from "./schema-transition";
import { readTerminalControlSnapshot } from "./terminal-control-authority";
import type { UpgradeApplicationAdmission } from "./upgrade-application-admission";
import {
  cursorFor,
  providerFor,
  replaceCursor,
  samePlan,
  stepKey,
} from "./upgrade-execution-support";
import {
  recheckFinalAuthorities,
  validateFinalContexts,
} from "./upgrade-final-validation";
import { planRuntimeUpgrade } from "./upgrade-planner";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

export async function applyRuntimeUpgrade(
  runtime: UpgradeRuntimeHost,
  control: Awaited<ReturnType<typeof createControlService>>,
  input: UpgradeApplyRequest,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult> {
  const request = upgradeApplyRequestSchema.parse(structuredClone(input));
  const planned = await planRuntimeUpgrade(
    runtime.configService,
    request.request,
  );
  if (planned.result.status !== "ready")
    throw createWeaverError("REVISION_CONFLICT", "Upgrade plan is stale");
  await runtime.enterMaintenance();
  const recomputed = await planRuntimeUpgrade(
    runtime.configService,
    request.request,
  );
  if (
    recomputed.result.status !== "ready" ||
    !samePlan(recomputed.result.plan, planned.result.plan)
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Upgrade authority changed before persistence",
    );
  return executeNew(
    runtime,
    control,
    planned.result.plan,
    admission,
    request.runId,
  );
}

async function executeNew(
  runtime: UpgradeRuntimeHost,
  control: Awaited<ReturnType<typeof createControlService>>,
  plan: InternalUpgradePlan,
  admission: UpgradeApplicationAdmission,
  requestedRunId?: string,
) {
  const runId = requestedRunId ?? randomUUID();
  assertWrite(await control.storePlan(plan, control.revision));
  let journal: InternalRecoveryEnvelope = {
    version: 1,
    runId,
    planId: plan.id,
    owner: control.owner,
    source: BUILTIN_CATALOG_REFERENCE,
    target: plan.target.builtinCatalog ?? BUILTIN_CATALOG_REFERENCE,
    infrastructureGeneration: plan.source.infrastructureGeneration,
    phase: "prepared",
    activation: { status: "pending" },
    sourceRevisions: cursorFor(plan),
    control: controlBinding(runtime, plan),
    steps: plan.steps.map((step) => ({
      id: step.id,
      target: step.target,
      operationId: randomUUID(),
      preRevision: step.expectedRevision,
      preDigest: step.preDigest,
      postDigest: step.postDigest,
      mutation: step.mutation,
      ...(step.undo ? { undo: step.undo } : {}),
      status: "pending" as const,
    })),
  };
  assertWrite(await control.recordJournal(journal, control.revision));
  journal = parseJournal({
    ...journal,
    phase: "applying",
    cursor: cursorFor(plan),
  });
  await persist(control, journal);
  for (const step of plan.steps)
    journal = await applyUpgradeStep(runtime, control, plan, journal, step.id);
  journal = parseJournal({ ...journal, phase: "verifying" });
  await persist(control, journal);
  return activateUpgradePlan(runtime, control, plan, journal, admission);
}

function controlBinding(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
) {
  const state = controlProjection(runtime.configService).prepared()
    .configuration;
  const provider = runtime.configService.providers.find((item) =>
    plan.source.providerRevisions
      .find((source) => source.providerId === item.id)
      ?.revisions.some((revision) => revision.storeId === state.format.storeId),
  );
  const source = plan.source.providerRevisions.find(
    (item) => item.providerId === provider?.id,
  );
  const revision = source?.revisions.find(
    (item) => item.layer === provider?.layer,
  );
  return provider && revision
    ? {
        providerId: provider.id,
        revision,
        receipts: [],
        operationId: randomUUID(),
      }
    : undefined;
}

export async function applyUpgradeStep(
  runtime: UpgradeRuntimeHost,
  control: Awaited<ReturnType<typeof createControlService>>,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  id: string,
): Promise<InternalRecoveryEnvelope> {
  const index = journal.steps.findIndex((step) => step.id === id);
  const step = plan.steps[index];
  if (!step)
    throw createWeaverError("VALIDATION_ERROR", "Upgrade step is missing");
  const intent = prepareIntent(journal, step, index);
  journal = parseJournal({
    ...journal,
    steps: journal.steps.map((value, i) => (i === index ? intent : value)),
  });
  await persist(control, journal, intent.intentOperationId);
  const result = await control.repairStep(journal.runId, id, control.revision);
  assertWrite(result);
  const receipt = await readStepReceipt(runtime, step, intent.operationId);
  const complete = { ...intent, status: "complete" as const, receipt };
  journal = parseJournal({
    ...journal,
    steps: journal.steps.map((value, i) => (i === index ? complete : value)),
    cursor: replaceCursor(journal, step.target.providerId, receipt.revision),
  });
  await persist(control, journal);
  return journal;
}

function prepareIntent(
  journal: InternalRecoveryEnvelope,
  step: InternalUpgradePlan["steps"][number],
  index: number,
) {
  const current = journal.steps[index];
  if (!current)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Upgrade journal step is missing",
    );
  const cursor =
    "cursor" in journal
      ? journal.cursor?.find(
          (item) =>
            item.providerId === step.target.providerId &&
            item.revision.layer === step.target.layer,
        )
      : undefined;
  return {
    ...current,
    preRevision: cursor?.revision ?? current.preRevision,
    status: "intent" as const,
    intentOperationId: randomUUID(),
  };
}

function readStepReceipt(
  runtime: UpgradeRuntimeHost,
  step: InternalUpgradePlan["steps"][number],
  operationId: string,
) {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const provider = providerFor(host, step);
    const envelope = await provider.authority?.readLayer(step.target.layer);
    if (
      !envelope?.lastCommit ||
      envelope.lastCommit.operationId !== operationId
    )
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Upgrade receipt is unavailable",
      );
    if (
      rawTargetDigest(deepGet(envelope.entries, stepKey(step))) !==
      step.postDigest
    )
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Upgrade post-state digest mismatch",
      );
    return envelope.lastCommit;
  });
}

function rawTargetDigest(value: unknown): string {
  return transitionDigest({
    absent: value === undefined,
    ...(value === undefined ? {} : { value }),
  });
}

export async function activateUpgradePlan(
  runtime: UpgradeRuntimeHost,
  control: Awaited<ReturnType<typeof createControlService>>,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult> {
  journal = await control.readRecovery(journal.runId);
  const finalContexts = await validateFinalContexts(runtime, plan, journal);
  journal = await persistActivationIntent(
    runtime,
    control,
    plan,
    journal,
    finalContexts.binding,
  );
  await recheckFinalAuthorities(runtime, plan, journal);
  const prestate = await inspectActivationEvidence(runtime, plan, journal);
  if (prestate.status !== "prestate")
    throw createWeaverError(
      "REVISION_CONFLICT",
      `Activation authority changed after intent persistence: ${prestate.status === "mismatch" ? prestate.reason : prestate.status}`,
    );
  const activationWrite = await control.activateUpgrade(
    journal,
    plan,
    control.revision,
  );
  assertWrite(activationWrite.result);
  const evidence = await inspectActivationEvidence(runtime, plan, journal);
  if (evidence.status !== "poststate")
    throw createWeaverError(
      "COMMIT_OUTCOME_UNKNOWN",
      "Activation poststate and receipt are unavailable",
    );
  return completeActivation(
    runtime,
    control,
    journal,
    evidence.receipt,
    finalContexts,
    admission,
  );
}

async function completeActivation(
  runtime: UpgradeRuntimeHost,
  control: Awaited<ReturnType<typeof createControlService>>,
  journal: InternalRecoveryEnvelope,
  receipt: NonNullable<LayerEnvelope["lastCommit"]>,
  contexts: ValidatedFinalContexts,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult> {
  const intent = journal.activation;
  if (intent?.status !== "intent")
    throw createWeaverError("VALIDATION_ERROR", "Activation intent is missing");
  const final = parseJournal({
    ...journal,
    phase: intent.terminal,
    activation: {
      ...intent,
      status: "complete",
      poststateDigest: intent.candidateDigest,
      receipt,
    },
  });
  await control.completeActivation(final);
  const durable = await control.readRecovery(final.runId);
  if (intent.terminal === "completed") {
    const authority = await readTerminalControlSnapshot(runtime, durable);
    await admission.fresh(contexts, authority);
  } else runtime.requireRestart();
  return result(durable);
}

async function persistActivationIntent(
  runtime: UpgradeRuntimeHost,
  control: Awaited<ReturnType<typeof createControlService>>,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  binding: Parameters<typeof prepareActivationIntent>[4],
) {
  const prepared = await control.prepareJournal(journal);
  const intent = await prepareActivationIntent(
    runtime,
    plan,
    prepared,
    randomUUID(),
    binding,
  );
  const parsed = parseJournal(intent);
  assertWrite(await control.replacePreparedJournal(parsed, control.revision));
  return control.readRecovery(journal.runId);
}

async function persist(
  control: Awaited<ReturnType<typeof createControlService>>,
  journal: InternalRecoveryEnvelope,
  operationId?: string,
): Promise<void> {
  assertWrite(
    await control.replaceJournal(journal, control.revision, operationId),
  );
}

function assertWrite(value: WriteResult): void {
  if (!value.success)
    throw createWeaverError(
      "REVISION_CONFLICT",
      value.error?.message ?? "Upgrade write failed",
    );
}

function parseJournal(value: unknown): InternalRecoveryEnvelope {
  return internalRecoveryEnvelopeSchema.parse(value);
}

function result(
  journal: InternalRecoveryEnvelope,
): InternalUpgradeExecutionResult {
  return internalUpgradeResult(journal);
}
