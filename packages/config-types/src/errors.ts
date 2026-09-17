import { z } from "zod";

/** All known Weaver error codes for typed error handling across packages. */
export const weaverErrorCodes = [
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "SCOPE_NOT_FOUND",
  "SCOPE_NOT_LOADED",
  "SCHEMA_CONFLICT",
  "POLICY_VIOLATION",
  "VALIDATION_ERROR",
  "GIT_ERROR",
  "SERVER_DEGRADED",
  "SIZE_WARNING",
  "QUEUE_FULL",
  "SESSION_REQUIRED",
  "SESSION_BLOCKED",
  "REVISION_CONFLICT",
  "INTERNAL_ERROR",
  "PROVIDER_CORRUPT",
  "PROVIDER_LOAD_FAILED",
  "UNSUPPORTED_AUTHORITY",
  "WRITER_CONFLICT",
  "COMMIT_OUTCOME_UNKNOWN",
  "WRITE_ERROR",
  "CONFIG_NOT_READY",
  "MAINTENANCE",
] as const;

export const weaverErrorCodeSchema = z.enum(weaverErrorCodes);
export type WeaverErrorCode = z.infer<typeof weaverErrorCodeSchema>;

export const weaverErrorSchema = z.object({
  code: weaverErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type WeaverError = z.infer<typeof weaverErrorSchema>;

/** Typed Error subclass carrying a WeaverErrorCode and optional details. */
export class WeaverErrorInstance extends Error {
  readonly code: WeaverErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: WeaverErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WeaverError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * Factory for creating typed Weaver errors with code, message, and optional details.
 *
 * @param code - Error category from the WeaverErrorCode enum
 * @param message - Human-readable description
 * @param details - Optional structured context for debugging
 */
export function createWeaverError(
  code: WeaverErrorCode,
  message: string,
  details?: Record<string, unknown>,
): WeaverErrorInstance {
  return new WeaverErrorInstance(code, message, details);
}
