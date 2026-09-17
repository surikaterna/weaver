import { createWeaverError, type WriteResult } from "@weaver-conf/config-types";

export function assertUpgradeWrite(result: WriteResult, message: string): void {
  if (result.success) return;
  const code =
    result.error?.code === "COMMIT_OUTCOME_UNKNOWN" ||
    result.error?.code === "REVISION_CONFLICT"
      ? result.error.code
      : "WRITE_ERROR";
  throw createWeaverError(code, message);
}
