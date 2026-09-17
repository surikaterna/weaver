import {
  type InternalRecoveryEnvelope,
  type PublicMaintenanceFailureCode,
  type PublicUpgradeEffects,
  publicMaintenanceFailure,
  publicMaintenanceFailureCodeSchema,
  type UpgradeExecutionResult,
  upgradeExecutionResultSchema,
  type WeaverErrorCode,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";

export interface InternalUpgradeExecutionResult {
  readonly version: 1;
  readonly runId: string;
  readonly planId: string;
  readonly status: "completed" | "restart-required" | "blocked" | "compensated";
  readonly journal: InternalRecoveryEnvelope;
}

export function publicUpgradeResult(
  internal: InternalUpgradeExecutionResult,
): UpgradeExecutionResult {
  const { journal } = internal;
  const { status } = internal;
  return upgradeExecutionResultSchema.parse({
    version: 1,
    runId: journal.runId,
    status,
    effects: publicUpgradeEffects(journal),
    ...(status === "blocked"
      ? { failure: publicMaintenanceFailure(journalFailureCode(journal)) }
      : {}),
  });
}

export function internalUpgradeResult(
  journal: InternalRecoveryEnvelope,
): InternalUpgradeExecutionResult {
  return {
    version: 1,
    runId: journal.runId,
    planId: journal.planId,
    status: publicStatus(journal.phase),
    journal,
  };
}

export function publicUpgradeFailure(
  error: unknown,
  fallback: PublicMaintenanceFailureCode = "internal",
) {
  return publicMaintenanceFailure(errorCode(error) ?? fallback);
}

export function publicUpgradeError(error: unknown): WeaverErrorInstance {
  const failure = publicUpgradeFailure(error);
  return new WeaverErrorInstance(publicErrorCode(error), failure.message, {
    maintenanceCode: failure.code,
    category: failure.category,
  });
}

export function publicUpgradeEffects(
  journal: InternalRecoveryEnvelope,
): PublicUpgradeEffects {
  const completedSteps = journal.steps.filter(
    (step) => step.status === "complete",
  ).length;
  const pendingSteps = journal.steps.length - completedSteps;
  return {
    partialEffects:
      completedSteps > 0 &&
      !["completed", "restart-required", "compensated"].includes(journal.phase),
    completedSteps,
    pendingSteps,
    quarantinedProviders: [],
  };
}

function journalFailureCode(
  journal: InternalRecoveryEnvelope,
): PublicMaintenanceFailureCode {
  if (journal.phase !== "blocked") return "internal";
  return journal.failure.code;
}

function publicStatus(phase: InternalRecoveryEnvelope["phase"]) {
  if (
    phase === "completed" ||
    phase === "restart-required" ||
    phase === "compensated"
  )
    return phase;
  return "blocked" as const;
}

function errorCode(error: unknown): PublicMaintenanceFailureCode | undefined {
  if (isPublicFailureCode(error)) return error.code;
  if (!isErrorWithCode(error)) return undefined;
  return publicCodeByWeaverCode[error.code];
}

function isPublicFailureCode(
  error: unknown,
): error is { code: PublicMaintenanceFailureCode } {
  if (typeof error !== "object" || error === null || !("code" in error))
    return false;
  return publicMaintenanceFailureCodeSchema.safeParse(error.code).success;
}

function isErrorWithCode(error: unknown): error is { code: WeaverErrorCode } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code in publicCodeByWeaverCode
  );
}

const publicCodeByWeaverCode: Readonly<
  Partial<Record<WeaverErrorCode, PublicMaintenanceFailureCode>>
> = {
  REVISION_CONFLICT: "stale-plan",
  WRITER_CONFLICT: "conflict",
  COMMIT_OUTCOME_UNKNOWN: "unknown-commit",
  VALIDATION_ERROR: "validation",
  UNSUPPORTED_AUTHORITY: "ownership",
  FORBIDDEN: "ownership",
  GIT_ERROR: "storage",
  PROVIDER_CORRUPT: "storage",
  PROVIDER_LOAD_FAILED: "storage",
  WRITE_ERROR: "storage",
};

function publicErrorCode(error: unknown): WeaverErrorCode {
  if (!isErrorWithCode(error)) return "INTERNAL_ERROR";
  if (
    error.code === "REVISION_CONFLICT" ||
    error.code === "VALIDATION_ERROR" ||
    error.code === "UNSUPPORTED_AUTHORITY" ||
    error.code === "COMMIT_OUTCOME_UNKNOWN" ||
    error.code === "FORBIDDEN"
  )
    return error.code;
  return "INTERNAL_ERROR";
}
