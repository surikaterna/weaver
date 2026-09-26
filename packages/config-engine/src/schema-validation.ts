import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { createConfigurationValidationSession } from "./schema-validation-session";
import {
  type SchemaValidationOptions,
  type SchemaValidationPathSegment,
  type SchemaValidationResult,
  toPathSegmentsResult,
} from "./schema-validation-support";

export type {
  SchemaValidationError,
  SchemaValidationErrorCode,
  SchemaValidationOptions,
  SchemaValidationPathSegment,
  SchemaValidationResult,
} from "./schema-validation-support";

export function validatePartialConfiguration(
  schema: ConfigurationPropertySchema,
  value: unknown,
  options?: SchemaValidationOptions,
): SchemaValidationResult {
  return createConfigurationValidationSession(schema, options).validatePartial(
    value,
  );
}

export function validateEffectiveConfiguration(
  schema: ConfigurationPropertySchema,
  value: unknown,
  options?: SchemaValidationOptions,
): SchemaValidationResult {
  return createConfigurationValidationSession(
    schema,
    options,
  ).validateEffective(value);
}

export function validateConfigurationPatch(
  schema: ConfigurationPropertySchema,
  path: string | readonly SchemaValidationPathSegment[],
  value: unknown,
  options?: SchemaValidationOptions,
): SchemaValidationResult {
  const basePath = toPathSegmentsResult(options?.path);
  if (basePath.error !== undefined) return invalidPathResult(basePath.error);
  const patchPath = toPathSegmentsResult(path, basePath.segments);
  if (patchPath.error !== undefined) return invalidPathResult(patchPath.error);
  return createConfigurationValidationSession(schema, {
    path: basePath.segments,
  }).validatePatch(patchPath.segments, value);
}

function invalidPathResult(
  error: SchemaValidationResult["errors"][number],
): SchemaValidationResult {
  return { valid: false, errors: [error] };
}
