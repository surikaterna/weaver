import { randomUUID } from "node:crypto";
import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalRecoveryEnvelopeSchema,
} from "@weaver-conf/config-types";
import type { ConfigServiceController } from "./config-service-controller";
import { runMaintenanceOperation } from "./config-service-internal";
import type { createControlService } from "./control-service";
import {
  assertCompensationOrder,
  assertCompensationStepBinding,
  type CompleteStep,
  compensationCursor,
  compensationRevision,
  exactCompensationPrestate,
  exactCompensationReceipt,
  type LayerCommitReceipt,
} from "./upgrade-compensation-evidence";
import {
  providerFor,
  replaceCursor,
  stepKey,
} from "./upgrade-execution-support";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";
import { assertUpgradeWrite } from "./upgrade-write-result";

type Control = Awaited<ReturnType<typeof createControlService>>;

export async function compensateUpgrade(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): Promise<InternalRecoveryEnvelope> {
  const completed = [...journal.steps]
    .filter((step) => step.status === "complete")
    .reverse();
  if (journal.activation?.status === "complete")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Activated upgrades cannot be compensated in place",
    );
  if (completed.some((step) => !step.undo))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Completed step has no reversible undo",
    );
  assertCompensationOrder(completed);
  if (journal.phase === "compensated") return journal;
  let current: InternalRecoveryEnvelope = parseJournal(journal);
  for (const step of completed)
    current = await compensateCompletedStep(
      runtime,
      control,
      plan,
      current,
      step.id,
    );
  if (current.phase !== "compensated") {
    current = parseJournal({ ...current, phase: "compensated" });
    await persist(control, current);
  }
  return current;
}

async function compensateCompletedStep(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  id: string,
): Promise<InternalRecoveryEnvelope> {
  let current = journal;
  let recorded = completedStep(current, id);
  if (recorded.compensation?.status === "complete") return current;
  const planned = plan.steps.find((step) => step.id === recorded.id);
  if (!planned?.undo)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Compensation metadata is missing",
    );
  assertCompensationStepBinding(planned, recorded);
  if (recorded.compensation?.status !== "intent") {
    current = compensationIntent(current, recorded, randomUUID());
    await persist(control, current);
    recorded = completedStep(current, id);
  }
  const receipt = await reconcileCompensation(
    runtime,
    planned,
    current,
    recorded,
  );
  current = compensationComplete(
    current,
    id,
    planned.target.providerId,
    receipt,
  );
  await persist(control, current);
  return current;
}

function completedStep(
  journal: InternalRecoveryEnvelope,
  id: string,
): CompleteStep {
  const step = journal.steps.find((item) => item.id === id);
  if (step?.status !== "complete")
    throw createWeaverError("VALIDATION_ERROR", "Compensation step changed");
  return step;
}

function compensationIntent(
  journal: InternalRecoveryEnvelope,
  recorded: Extract<
    InternalRecoveryEnvelope["steps"][number],
    { status: "complete" }
  >,
  operationId: string,
): InternalRecoveryEnvelope {
  const retryable = withoutFailure(journal);
  return parseJournal({
    ...retryable,
    phase: "compensating",
    cursor: compensationCursor(journal),
    steps: journal.steps.map((step) =>
      step.id === recorded.id
        ? { ...recorded, compensation: { status: "intent", operationId } }
        : step,
    ),
  });
}

async function reconcileCompensation(
  runtime: UpgradeRuntimeHost,
  planned: InternalUpgradePlan["steps"][number],
  journal: InternalRecoveryEnvelope,
  recorded: CompleteStep,
): Promise<LayerCommitReceipt> {
  const intent = recorded.compensation;
  if (intent?.status !== "intent")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Compensation intent is missing",
    );
  const expected = compensationRevision(journal, planned);
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const provider = providerFor(host, planned);
    const envelope = await provider.authority?.readLayer(planned.target.layer);
    if (!envelope)
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Provider read is uncertain",
      );
    const receipt = exactCompensationReceipt(
      planned,
      recorded,
      expected,
      intent.operationId,
      envelope,
    );
    if (receipt) return receipt;
    if (
      exactCompensationPrestate(journal, planned, recorded, expected, envelope)
    )
      return compensateStep(host, planned, intent.operationId);
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Compensation intent matches neither exact prestate nor poststate",
    );
  });
}

async function compensateStep(
  host: ConfigServiceController,
  planned: InternalUpgradePlan["steps"][number],
  operationId: string,
): Promise<LayerCommitReceipt> {
  const undo = planned.undo;
  if (!undo)
    throw createWeaverError("VALIDATION_ERROR", "Compensation undo is missing");
  const provider = providerFor(host, planned);
  const outcome = await host.authority.commit(
    provider,
    planned.target.layer,
    stepKey(planned),
    undo.action === "set" ? undo.value : undefined,
    undo.action === "remove",
    operationId,
  );
  assertUpgradeWrite(outcome.result, "Compensation write failed");
  if (!outcome.snapshot?.lastCommit)
    throw createWeaverError(
      "COMMIT_OUTCOME_UNKNOWN",
      "Compensation was not durably acknowledged",
    );
  return outcome.snapshot.lastCommit;
}

function compensationComplete(
  journal: InternalRecoveryEnvelope,
  id: string,
  providerId: string,
  receipt: LayerCommitReceipt,
): InternalRecoveryEnvelope {
  const retryable = withoutFailure(journal);
  const remaining = journal.steps.some(
    (step) =>
      step.status === "complete" &&
      step.id !== id &&
      step.compensation?.status !== "complete",
  );
  return parseJournal({
    ...retryable,
    phase: remaining ? "compensating" : "compensated",
    steps: journal.steps.map((step) => {
      if (step.id !== id || step.status !== "complete") return step;
      if (step.compensation?.status !== "intent")
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Compensation completion has no exact intent",
        );
      return {
        ...step,
        compensation: {
          status: "complete",
          operationId: step.compensation.operationId,
          receipt,
        },
      };
    }),
    cursor: replaceCursor(journal, providerId, receipt.revision),
  });
}

function withoutFailure(journal: InternalRecoveryEnvelope) {
  if (journal.phase !== "blocked") return journal;
  const { failure: _failure, ...retryable } = journal;
  return retryable;
}

async function persist(
  control: Control,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  const value = await control.replaceJournal(journal, control.revision);
  assertUpgradeWrite(value, "Compensation journal write failed");
}

function parseJournal(value: unknown): InternalRecoveryEnvelope {
  return internalRecoveryEnvelopeSchema.parse(value);
}
