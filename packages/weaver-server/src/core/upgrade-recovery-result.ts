import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  internalRecoveryEnvelopeSchema,
} from "@weaver-conf/config-types";
import type { createControlService } from "./control-service";
import {
  type InternalUpgradeExecutionResult,
  internalUpgradeResult,
} from "./public-upgrade-status";

type Control = Awaited<ReturnType<typeof createControlService>>;

export async function blockRecovery(
  control: Control,
  journal: InternalRecoveryEnvelope,
  code: "conflict" | "unknown-commit" | "operator-required",
  message: string,
  stepId?: string,
): Promise<InternalUpgradeExecutionResult> {
  const blocked = parseRecoveryJournal({
    ...journal,
    phase: "blocked",
    failure: { code, message, ...(stepId ? { stepId } : {}) },
  });
  await persistRecoveryJournal(control, blocked);
  return recoveryResult(blocked);
}

export function parseRecoveryJournal(value: unknown): InternalRecoveryEnvelope {
  return internalRecoveryEnvelopeSchema.parse(value);
}

export async function persistRecoveryJournal(
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

export function recoveryResult(
  journal: InternalRecoveryEnvelope,
): InternalUpgradeExecutionResult {
  return internalUpgradeResult(journal);
}
