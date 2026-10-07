import type {
  CanonicalConfigPath,
  SchemaValidationPathSegment,
  SchemaValidationResult,
} from "@weaver-conf/config-engine";
import {
  assertPublicConfigPath,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import type { SchemaPatchResult } from "@weaver-conf/config-service/admission";
import type {
  FailedSchemaWrite,
  ResolvedWriteAnchor,
} from "./config-service-schema-writes";

export function writeFailure(
  message: string,
  details: Record<string, unknown>,
  code: "VALIDATION_ERROR" | "SCHEMA_NOT_REGISTERED" = "VALIDATION_ERROR",
): FailedSchemaWrite {
  return {
    success: false,
    result: {
      success: false,
      error: { code, message, details },
    },
  };
}

export function validationFailure(
  validation: SchemaValidationResult,
  resolved: ResolvedWriteAnchor,
): FailedSchemaWrite {
  const unsupportedPath =
    validation.errors.length > 0 &&
    validation.errors.every((error) => error.code === "unknown-property");
  return writeFailure(
    "Configuration does not match registered schema",
    {
      path: resolved.path,
      anchorPath: resolved.anchor.path,
      environment: resolved.environment,
      errors: validation.errors,
    },
    unsupportedPath ? "SCHEMA_NOT_REGISTERED" : "VALIDATION_ERROR",
  );
}

export function patchFailure(
  failure: Exclude<SchemaPatchResult, { readonly success: true }>,
  resolved: ResolvedWriteAnchor,
): FailedSchemaWrite {
  const details = {
    path: resolved.path,
    anchorPath: resolved.anchor.path,
    environment: resolved.environment,
  };
  if (failure.reason === "array-index-out-of-range") {
    return writeFailure(
      `Array patch index ${String(failure.index)} exceeds current length ${String(failure.length)}`,
      { ...details, index: failure.index, length: failure.length },
    );
  }
  return writeFailure("Configuration patch cannot traverse the current value", {
    ...details,
    segment: failure.segment,
  });
}

type NormalizedPath =
  | { readonly success: true; readonly value: CanonicalConfigPath }
  | { readonly success: false; readonly message: string };

export function normalizeCanonicalPath(path: string): NormalizedPath {
  try {
    const value = parseCanonicalConfigPath(assertPublicConfigPath(path));
    return value.segments.length === 0
      ? { success: false, message: "Configuration writes must not target root" }
      : { success: true, value };
  } catch (error: unknown) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function invalidPathValidation(
  message: string,
  segments: readonly SchemaValidationPathSegment[] = [],
): SchemaValidationResult {
  return {
    valid: false,
    errors: [
      {
        code: "invalid-path",
        message,
        segments: [...segments],
        path: segments.reduce<string>(
          (current, segment) => `${current}.${String(segment)}`,
          "$",
        ),
      },
    ],
  };
}
