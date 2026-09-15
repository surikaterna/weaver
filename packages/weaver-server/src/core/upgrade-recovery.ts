import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalRecoveryEnvelopeSchema,
  type UpgradeRecoveryRequest,
  upgradeRecoveryRequestSchema,
} from "@weaver-conf/config-types";
import {
  type ActivationEvidence,
  inspectActivationEvidence,
} from "./activation-recovery";
import { assertSupportedSourceBuiltinCatalog } from "./builtin-catalog";
import {
  applicationAdmission,
  controlProjection,
  runMaintenanceOperation,
} from "./config-service-internal";
import type { createControlService } from "./control-service";
import {
  type InternalUpgradeExecutionResult,
  internalUpgradeResult,
} from "./public-upgrade-status";
import { recoverTerminalUpgrade } from "./terminal-upgrade-recovery";
import { completeRecoveredActivation } from "./upgrade-activation-completion";
import type { UpgradeApplicationAdmission } from "./upgrade-application-admission";
import { compensateUpgrade } from "./upgrade-compensation";
import { reconstructFinalContexts } from "./upgrade-context-recovery";
import {
  committedReceipt,
  exactPrestate,
  providerFor,
  replaceCursor,
} from "./upgrade-execution-support";
import { applyUpgradeStep } from "./upgrade-executor";
import { isProjectedTerminal } from "./upgrade-recovery-projection";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

type Control = Awaited<ReturnType<typeof createControlService>>;
export async function recoverRuntimeUpgrade(
  runtime: UpgradeRuntimeHost,
  control: Control,
  input: UpgradeRecoveryRequest,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult> {
  const request = upgradeRecoveryRequestSchema.parse(structuredClone(input));
  let journal: InternalRecoveryEnvelope;
  try {
    journal = await control.readRecovery(request.runId);
  } catch (error) {
    if (isProjectedTerminal(runtime, request.runId)) {
      if (applicationAdmission(runtime.configService))
        await runtime.enterMaintenance();
      runtime.requireRestart();
    }
    throw error;
  }
  const terminal = await recoverTerminalUpgrade(runtime, journal, admission);
  if (terminal) return terminal;
  assertSupportedSourceBuiltinCatalog(journal.source);
  await runtime.enterMaintenance();
  const plan = controlProjection(runtime.configService).prepared().configuration
    .upgrades.plans[journal.planId];
  if (!plan)
    throw createWeaverError("CONFIG_NOT_READY", "Recovery plan is missing");
  journal = await adopt(runtime, control, plan, journal, request);
  const adoptedTerminal = await recoverTerminalUpgrade(
    runtime,
    journal,
    admission,
  );
  if (adoptedTerminal) return adoptedTerminal;
  if (request.action === "compensate")
    try {
      return result(await compensateUpgrade(runtime, control, plan, journal));
    } catch (error) {
      const durable = await control.readRecovery(request.runId);
      return block(
        control,
        durable,
        error instanceof Error && error.message.includes("acknowledged")
          ? "unknown-commit"
          : "operator-required",
        error instanceof Error ? error.message : "Compensation failed",
      );
    }
  return resume(runtime, control, plan, journal, admission);
}
async function adopt(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  request: UpgradeRecoveryRequest,
) {
  if (journal.owner === control.owner) return journal;
  if (!request.priorOwnerStopped)
    throw createWeaverError(
      "FORBIDDEN",
      "Explicit prior-owner-stopped evidence is required",
    );
  const adopted = adoptionJournal(control, journal, request);
  if (journal.activation?.status !== "intent") {
    await persist(control, adopted);
    return adopted;
  }
  const evidence = await inspectActivationEvidence(runtime, plan, journal);
  if (evidence.status === "mismatch")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Activation cannot be adopted from ambiguous authority",
    );
  if (evidence.status === "prestate") {
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Validated final context evidence is unavailable for activation adoption",
    );
  }
  const completed = parseJournal({
    ...journal,
    phase: journal.activation.terminal,
    activation: {
      ...journal.activation,
      status: "complete",
      poststateDigest: journal.activation.candidateDigest,
      receipt: evidence.receipt,
    },
  });
  await control.completeActivation(completed);
  return completed;
}
function adoptionJournal(
  control: Control,
  journal: InternalRecoveryEnvelope,
  request: UpgradeRecoveryRequest,
): InternalRecoveryEnvelope {
  return parseJournal({
    ...journal,
    owner: control.owner,
    adoption: {
      previousOwner: journal.owner,
      adoptedBy: control.owner,
      priorOwnerStopped: request.priorOwnerStopped,
    },
  });
}

async function resume(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult> {
  if (["completed", "restart-required", "compensated"].includes(journal.phase))
    return result(journal);
  if (journal.phase === "prepared")
    journal = parseJournal({
      ...journal,
      phase: "applying",
      cursor: journal.sourceRevisions,
    });
  journal = await reconcileSteps(runtime, control, plan, journal);
  if (journal.phase === "blocked") return result(journal);
  if (journal.activation?.status === "intent")
    return reconcileActivation(runtime, control, plan, journal, admission);
  if (journal.activation?.status !== "complete")
    return block(
      control,
      journal,
      "operator-required",
      "Validated final context evidence is unavailable after restart",
    );
  return result(journal);
}

async function reconcileSteps(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): Promise<InternalRecoveryEnvelope> {
  let current = journal;
  for (const step of plan.steps) {
    const recorded = current.steps.find((item) => item.id === step.id);
    if (!recorded)
      return (
        await block(
          control,
          current,
          "operator-required",
          "Planned recovery step is missing",
          step.id,
        )
      ).journal;
    if (recorded.status === "pending") {
      current = await applyUpgradeStep(
        runtime,
        control,
        plan,
        current,
        step.id,
      );
      continue;
    }
    if (recorded.status === "complete") continue;
    current = await reconcileIntent(runtime, control, plan, current, step.id);
    if (current.phase === "blocked") return current;
  }
  return current;
}

async function reconcileActivation(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult> {
  const expected = journal.activation;
  if (expected?.status !== "intent")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Activation recovery requires an intent",
    );
  const contexts = await reconstructFinalContexts(runtime, plan, journal);
  let evidence: ActivationEvidence;
  try {
    evidence = await recoverActivationEvidence(runtime, control, plan, journal);
  } catch {
    return block(
      control,
      journal,
      "unknown-commit",
      "Activation outcome requires operator confirmation",
    );
  }
  if (evidence.status !== "poststate")
    return block(
      control,
      journal,
      "operator-required",
      "Activation intent does not match the exact control receipt",
    );
  return completeRecoveredActivation(
    runtime,
    control,
    journal,
    expected,
    evidence,
    contexts,
    admission,
  );
}

async function recoverActivationEvidence(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
) {
  let evidence = await inspectActivationEvidence(runtime, plan, journal);
  if (evidence.status === "prestate") {
    try {
      const activation = await control.activateUpgrade(
        journal,
        plan,
        control.revision,
      );
      if (!activation.result.success)
        throw createWeaverError(
          "REVISION_CONFLICT",
          activation.result.error?.message ?? "Activation write failed",
        );
    } catch {
      evidence = await inspectActivationEvidence(runtime, plan, journal);
      if (evidence.status !== "poststate")
        throw createWeaverError(
          "COMMIT_OUTCOME_UNKNOWN",
          "Activation outcome is not durably recognizable",
        );
    }
    evidence = await inspectActivationEvidence(runtime, plan, journal);
  }
  return evidence;
}

async function reconcileIntent(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  id: string,
) {
  const index = journal.steps.findIndex((step) => step.id === id);
  const step = plan.steps[index];
  const recorded = journal.steps[index];
  if (!step || recorded?.status !== "intent")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Recovery intent is inconsistent",
    );
  const envelope = await runMaintenanceOperation(
    runtime.configService,
    async (host) => {
      const provider = providerFor(host, step);
      return provider.authority?.readLayer(step.target.layer);
    },
  );
  if (!envelope)
    throw createWeaverError(
      "COMMIT_OUTCOME_UNKNOWN",
      "Provider read is uncertain",
    );
  const receipt = committedReceipt(
    { ...step, id: recorded.operationId },
    envelope,
  );
  if (!receipt) {
    const pre = exactPrestate(step, envelope);
    if (pre)
      return block(
        control,
        journal,
        "operator-required",
        "Intent has exact prestate; operator must choose resume or compensation",
        step.id,
      ).then((value) => value.journal);
    return block(
      control,
      journal,
      "conflict",
      "Intent matches neither exact prestate nor committed receipt",
      step.id,
    ).then((value) => value.journal);
  }
  const complete = { ...recorded, status: "complete" as const, receipt };
  const next = parseJournal({
    ...journal,
    phase: "applying",
    steps: journal.steps.map((item, i) => (i === index ? complete : item)),
    cursor: replaceCursor(journal, step.target.providerId, receipt.revision),
  });
  await persist(control, next);
  return next;
}

async function block(
  control: Control,
  journal: InternalRecoveryEnvelope,
  code: "conflict" | "unknown-commit" | "operator-required",
  message: string,
  stepId?: string,
): Promise<InternalUpgradeExecutionResult> {
  const blocked = parseJournal({
    ...journal,
    phase: "blocked",
    failure: { code, message, ...(stepId ? { stepId } : {}) },
  });
  await persist(control, blocked);
  return result(blocked);
}

function parseJournal(value: unknown): InternalRecoveryEnvelope {
  return internalRecoveryEnvelopeSchema.parse(value);
}
async function persist(
  control: Control,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  const value = await control.replaceJournal(journal, control.revision);
  if (!value.success)
    throw createWeaverError(
      "REVISION_CONFLICT",
      value.error?.message ?? "Recovery journal write failed",
    );
}

function result(
  journal: InternalRecoveryEnvelope,
): InternalUpgradeExecutionResult {
  return internalUpgradeResult(journal);
}
