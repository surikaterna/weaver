import {
  type InternalRecoveryEnvelope,
  internalRecoveryEnvelopeSchema,
  type UpgradeActivation,
} from "@weaver-conf/config-types";
import type { ActivationEvidence } from "./activation-recovery";
import type { createControlService } from "./control-service";
import type { ValidatedFinalContexts } from "./final-context-evidence";
import {
  type InternalUpgradeExecutionResult,
  internalUpgradeResult,
} from "./public-upgrade-status";
import { readTerminalControlSnapshot } from "./terminal-control-authority";
import type { UpgradeApplicationAdmission } from "./upgrade-application-admission";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

export async function completeRecoveredActivation(
  runtime: UpgradeRuntimeHost,
  control: Awaited<ReturnType<typeof createControlService>>,
  journal: InternalRecoveryEnvelope,
  expected: Extract<UpgradeActivation, { status: "intent" }>,
  evidence: Extract<ActivationEvidence, { status: "poststate" }>,
  contexts: ValidatedFinalContexts,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult> {
  const completed = internalRecoveryEnvelopeSchema.parse({
    ...journal,
    phase: expected.terminal,
    activation: {
      ...expected,
      status: "complete",
      poststateDigest: expected.candidateDigest,
      receipt: evidence.receipt,
    },
  });
  await control.completeActivation(completed);
  const durable = await control.readRecovery(completed.runId);
  if (expected.terminal === "completed") {
    const authority = await readTerminalControlSnapshot(runtime, durable);
    await admission.fresh(contexts, authority);
  } else runtime.requireRestart();
  return internalUpgradeResult(durable);
}
