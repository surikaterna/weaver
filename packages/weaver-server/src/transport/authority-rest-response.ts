import {
  configurationServiceWriteResultSchema,
  type WeaverErrorCode,
  WeaverErrorInstance,
  weaverErrorCodeSchema,
} from "@weaver-conf/config-types";
import { httpStatusForError } from "../types/errors";
import type { RestResponse } from "./rest-adapter";
import { envelope, errorEnvelope, v1Headers } from "./rest-helpers";

export function authorityError(code: WeaverErrorCode) {
  return { code, message: `Authority operation failed: ${code}` };
}
export function sanitizedAuthorityError(error: unknown) {
  const code =
    error instanceof WeaverErrorInstance
      ? weaverErrorCodeSchema.safeParse(error.code).data
      : undefined;
  return authorityError(code ?? "INTERNAL_ERROR");
}
export function authorityFailure(error: unknown): RestResponse {
  const safe = sanitizedAuthorityError(error);
  return {
    status: httpStatusForError(safe.code),
    body: errorEnvelope(safe, ""),
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  };
}
export function authoritySuccess(
  data: unknown,
  revision: string,
): RestResponse {
  return {
    status: 200,
    body: envelope(data, revision),
    headers: v1Headers(revision),
  };
}
export function authorityWriteResponse(input: unknown): RestResponse {
  const parsed = configurationServiceWriteResultSchema.safeParse(input);
  if (!parsed.success) return authorityFailure(undefined);
  const result = parsed.data;
  if (result.success) return authoritySuccess(result, result.revision);
  const error = authorityError(result.error.code);
  return {
    status: httpStatusForError(error.code),
    body: { ...envelope({ ...result, error }, ""), error },
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  };
}
