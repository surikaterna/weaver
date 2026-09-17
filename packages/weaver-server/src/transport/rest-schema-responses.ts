import type {
  SchemaRegistrationResponse,
  WriteResult,
} from "@weaver-conf/config-types";
import { configServiceTransportRevision } from "../core/config-service-lifecycle";
import type { WeaverConfigService } from "../core/config-service-types";
import type { WeaverErrorCode } from "../types/index";
import { createWeaverError, httpStatusForError } from "../types/index";
import type { RestResponse } from "./rest-adapter";
import { errorEnvelope, v1Headers } from "./rest-helpers";

export function schemaWriteFailureResponse(
  service: WeaverConfigService,
  fallback: string,
  result: WriteResult,
): RestResponse {
  const code = schemaWriteErrorCode(result);
  const revision = configServiceTransportRevision(service);
  const details = isRecord(result.error?.details)
    ? result.error.details
    : undefined;
  return {
    status: httpStatusForError(code),
    body: errorEnvelope(
      createWeaverError(code, result.error?.message ?? fallback, details),
      revision,
    ),
    headers: v1Headers(revision),
  };
}

export function schemaRegistrationFailureResponse(
  service: WeaverConfigService,
  result: SchemaRegistrationResponse,
): RestResponse {
  const code = result.error?.code ?? "VALIDATION_ERROR";
  const revision = configServiceTransportRevision(service);
  return {
    status: httpStatusForError(code),
    body: errorEnvelope(
      createWeaverError(
        code,
        result.error?.message ?? "Schema registration failed",
        result.error?.details,
      ),
      revision,
    ),
    headers: v1Headers(revision),
  };
}

function schemaWriteErrorCode(result: WriteResult): WeaverErrorCode {
  const code = result.error?.code;
  return code === "REVISION_CONFLICT" ||
    code === "MAINTENANCE" ||
    code === "SERVER_DEGRADED" ||
    code === "CONFIG_NOT_READY"
    ? code
    : "VALIDATION_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
