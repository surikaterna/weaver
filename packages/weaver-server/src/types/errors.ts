// Re-export shared error taxonomy from @weaver-conf/config-types

export type { WeaverError, WeaverErrorCode } from "@weaver-conf/config-types";
export {
  createWeaverError,
  weaverErrorCodeSchema,
  weaverErrorCodes,
  weaverErrorSchema,
} from "@weaver-conf/config-types";

// Server-specific HTTP status mapping (not shared to config-types)
import type { WeaverErrorCode } from "@weaver-conf/config-types";

export const HTTP_STATUS_MAP: Record<WeaverErrorCode, number> = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  SCOPE_NOT_FOUND: 404,
  SCOPE_NOT_LOADED: 409,
  SCHEMA_CONFLICT: 409,
  POLICY_VIOLATION: 400,
  VALIDATION_ERROR: 400,
  GIT_ERROR: 503,
  SERVER_DEGRADED: 503,
  SIZE_WARNING: 200,
  QUEUE_FULL: 429,
  SESSION_REQUIRED: 428,
  SESSION_BLOCKED: 403,
  REVISION_CONFLICT: 409,
  INTERNAL_ERROR: 500,
  PROVIDER_CORRUPT: 503,
  PROVIDER_LOAD_FAILED: 503,
  UNSUPPORTED_AUTHORITY: 409,
  WRITER_CONFLICT: 409,
  COMMIT_OUTCOME_UNKNOWN: 503,
  WRITE_ERROR: 503,
  CONFIG_NOT_READY: 503,
  MAINTENANCE: 503,
};

export function httpStatusForError(code: WeaverErrorCode): number {
  return HTTP_STATUS_MAP[code];
}
