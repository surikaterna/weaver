import type { WriteResult } from "@weaver-conf/config-types";
import type { WeaverConfigService } from "../core/config-service";
import type { WeaverErrorCode } from "../types/index";
import { createWeaverError, httpStatusForError } from "../types/index";
import type { RestRequest, RestResponse } from "./rest-adapter";
import { envelope, errorEnvelope, v1Headers } from "./rest-helpers";

export function v1Response<T>(
  configService: WeaverConfigService,
  status: number,
  data: T,
): RestResponse {
  const revision = configService.revision;
  return {
    status,
    body: envelope(data, revision),
    headers: v1Headers(revision),
  };
}

export function v1Error(
  configService: WeaverConfigService,
  code: WeaverErrorCode,
  message: string,
  details?: Record<string, unknown>,
): RestResponse {
  const revision = configService.revision;
  const error = createWeaverError(code, message, details);
  return {
    status: httpStatusForError(code),
    body: errorEnvelope(error, revision),
    headers: v1Headers(revision),
  };
}

export function extractExpectedRevision(
  request: RestRequest,
  options: { readonly strictQuotes?: boolean } = {},
): string | undefined {
  const value = request.headers["if-match"];
  if (value === undefined) return undefined;
  if (!options.strictQuotes) return value.replace(/^"|"$/g, "");
  if (!value.includes('"')) return value;
  const match = /^"([^"\r\n]+)"$/.exec(value);
  return match?.[1] ?? "";
}

interface WriteFailureOptions {
  readonly includeDetails?: boolean;
}

export function writeFailureResponse(
  configService: WeaverConfigService,
  result: WriteResult,
  fallback: string,
  options: WriteFailureOptions = {},
): RestResponse {
  const error = result.error;
  const code = writeErrorCode(error?.code);
  const details = options.includeDetails
    ? recordDetails(error?.details)
    : undefined;
  return v1Error(configService, code, error?.message ?? fallback, details);
}

function writeErrorCode(code: string | undefined): WeaverErrorCode {
  return code === "REVISION_CONFLICT"
    ? "REVISION_CONFLICT"
    : "VALIDATION_ERROR";
}

function recordDetails(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value;
}
