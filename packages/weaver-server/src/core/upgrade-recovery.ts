import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
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
import type { InternalUpgradeExecutionResult } from "./public-upgrade-status";
import {
  validateUpgradeRecoveryControl,
  validateUpgradeRecoveryIdentity,
  validateUpgradeRecoverySources,
} from "./schema-transition";
import { recoverTerminalUpgrade } from "./terminal-upgrade-recovery";
import { completeRecoveredActivation } from "./upgrade-activation-completion";
import type { UpgradeApplicationAdmission } from "./upgrade-application-admission";
import { compensateUpgrade } from "./upgrade-compensation";
import { reconstructFinalContexts } from "./upgrade-context-recovery";
import { activateUpgradePlan, applyUpgradeStep } from "./upgrade-executor";
import { validateFinalContexts } from "./upgrade-final-validation";
import {
  assertRecoveryAdoptionAuthorized,
  createAdoptionJournal,
  lacksSameOwnerFinalContextEvidence,
} from "./upgrade-recovery-adoption";
import { isProjectedTerminal } from "./upgrade-recovery-projection";
import {
  blockRecovery as block,
  parseRecoveryJournal as parseJournal,
  persistRecoveryJournal as persist,
  recoveryResult as result,
} from "./upgrade-recovery-result";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";
import {
  assertJournalPlanBinding,
  inspectUpgradeStepIntent,
  recoverUpgradeStepIntent,
  validateRecoveredStepPoststate,
} from "./upgrade-step-recovery";

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
  if (journal.phase === "blocked") return result(journal);
  assertSupportedSourceBuiltinCatalog(journal.source);
  await runtime.enterMaintenance();
  const plan = controlProjection(runtime.configService).prepared().configuration
    .upgrades.plans[journal.planId];
  if (!plan)
    throw createWeaverError("CONFIG_NOT_READY", "Recovery plan is missing");
  assertRecoveryAdoptionAuthorized(control.owner, journal, request);
  await preflight(runtime, plan, journal, request.runId);
  const adoptedByRecoveryAuthority = journal.owner !== control.owner;
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
  return resume(
    runtime,
    control,
    plan,
    journal,
    admission,
    adoptedByRecoveryAuthority,
  );
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
  const adopted = createAdoptionJournal(control.owner, journal, request);
  if (journal.activation?.status !== "intent") {
    await persist(control, adopted);
    return control.readRecovery(journal.runId);
  }
  const evidence = await inspectActivationEvidence(runtime, plan, journal);
  if (evidence.status === "mismatch")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Activation cannot be adopted from ambiguous authority",
    );
  if (evidence.status === "prestate") {
    const retry = parseJournal({
      ...adopted,
      activation: { status: "pending" },
    });
    await persist(control, retry);
    return control.readRecovery(journal.runId);
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
async function resume(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  admission: UpgradeApplicationAdmission,
  adoptedByRecoveryAuthority: boolean,
): Promise<InternalUpgradeExecutionResult> {
  if (["completed", "restart-required", "compensated"].includes(journal.phase))
    return result(journal);
  if (journal.phase === "prepared")
    journal = parseJournal({
      ...journal,
      phase: "applying",
      cursor: journal.sourceRevisions,
    });
  const recoveredUnrecordedEffect = lacksSameOwnerFinalContextEvidence(
    journal,
    adoptedByRecoveryAuthority,
  );
  journal = await reconcileSteps(runtime, control, plan, journal);
  if (journal.phase === "blocked") return result(journal);
  if (journal.activation?.status === "intent")
    return reconcileActivation(runtime, control, plan, journal, admission);
  if (
    journal.activation?.status === "pending" &&
    journal.steps.every((step) => step.status === "complete")
  )
    return resumePendingActivation(
      runtime,
      control,
      plan,
      journal,
      admission,
      recoveredUnrecordedEffect,
    );
  if (journal.activation?.status !== "complete")
    return block(
      control,
      journal,
      "operator-required",
      "Validated final context evidence is unavailable after restart",
    );
  return result(journal);
}
async function resumePendingActivation(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  admission: UpgradeApplicationAdmission,
  missingEvidence: boolean,
) {
  if (missingEvidence)
    return block(
      control,
      journal,
      "operator-required",
      "Validated final context evidence is unavailable after an unrecorded effect",
    );
  if (journal.phase !== "verifying") {
    journal = parseJournal({ ...journal, phase: "verifying" });
    await persist(control, journal);
  }
  return activateUpgradePlan(runtime, control, plan, journal, admission);
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
    current = await recoverUpgradeStepIntent(
      runtime,
      control,
      plan,
      current,
      step.id,
    );
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
async function preflight(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  runId: string,
): Promise<void> {
  assertJournalPlanBinding(plan, journal);
  await runMaintenanceOperation(runtime.configService, (host) =>
    validateUpgradeRecoveryControl(host, plan, journal, runId),
  );
  const intent = journal.steps.find((step) => step.status === "intent");
  const intentEvidence = intent
    ? await inspectUpgradeStepIntent(runtime, plan, journal, intent.id)
    : undefined;
  if (journal.activation?.status === "intent") {
    const evidence = await inspectActivationEvidence(runtime, plan, journal);
    if (evidence.status === "mismatch")
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Activation recovery authority is stale",
      );
    if (evidence.status === "prestate")
      await reconstructFinalContexts(runtime, plan, journal);
    return;
  }
  await runMaintenanceOperation(runtime.configService, (host) =>
    validateUpgradeRecoveryIdentity(host, plan, journal, runId),
  );
  if (intentEvidence?.status === "poststate") {
    await runMaintenanceOperation(runtime.configService, (host) =>
      validateUpgradeRecoverySources(host, plan, intentEvidence.journal),
    );
    await validateRecoveredStepPoststate(runtime, plan, intentEvidence.journal);
  } else if (
    journal.phase === "verifying" ||
    journal.steps.every((step) => step.status === "complete")
  )
    await validateFinalContexts(runtime, plan, journal);
  else
    await runMaintenanceOperation(runtime.configService, (host) =>
      validateUpgradeRecoverySources(host, plan, journal),
    );
}
