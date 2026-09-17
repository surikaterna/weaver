import {
  createWeaverError,
  type WriteResult,
  weaverErrorCodeSchema,
} from "@weaver-conf/config-types";

export function writeResultError(result: WriteResult) {
  const code = weaverErrorCodeSchema.safeParse(result.error?.code);
  return createWeaverError(
    code.success ? code.data : "INTERNAL_ERROR",
    result.error?.message ?? "Mutation failed",
    result.error?.details,
  );
}
