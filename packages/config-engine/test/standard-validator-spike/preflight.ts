import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { parsePath } from "../../src/path.js";
import {
  type SchemaValidationOptions,
  type SchemaValidationPathSegment,
  type SchemaValidationResult,
  validateConfigurationPatch,
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "../../src/schema-validation.js";
import { resolveMemberSchemas } from "../../src/schema-validation-paths.js";
import type { SpikeMode } from "./types.js";

export function baselineValidate(
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: SpikeMode,
): SchemaValidationResult {
  return mode === "effective"
    ? validateEffectiveConfiguration(schema, value)
    : validatePartialConfiguration(schema, value);
}

export function policyPreflight(
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: SpikeMode,
): SchemaValidationResult | undefined {
  const result = baselineValidate(schema, value, mode);
  const policyErrors = result.errors.filter(
    (error) =>
      error.code === "invalid-schema" ||
      error.message.includes("cycles") ||
      error.message === "Array item must be present",
  );
  return policyErrors.length === 0
    ? undefined
    : { valid: false, errors: policyErrors };
}

export function baselinePatch(
  schema: ConfigurationPropertySchema,
  path: string | readonly SchemaValidationPathSegment[],
  value: unknown,
  options?: SchemaValidationOptions,
): SchemaValidationResult {
  return validateConfigurationPatch(schema, path, value, options);
}

export function resolvePatchSchemas(
  schema: ConfigurationPropertySchema,
  path: string | readonly SchemaValidationPathSegment[],
  options?: SchemaValidationOptions,
): readonly ConfigurationPropertySchema[] {
  const base = parseSegments(options?.path);
  const member = parseSegments(path);
  return resolveMemberSchemas(schema, member, base).schemas;
}

export function patchSegments(
  path: string | readonly SchemaValidationPathSegment[],
  options?: SchemaValidationOptions,
): readonly SchemaValidationPathSegment[] {
  return [...parseSegments(options?.path), ...parseSegments(path)];
}

function parseSegments(
  path: string | readonly SchemaValidationPathSegment[] | undefined,
): readonly SchemaValidationPathSegment[] {
  if (path === undefined) return [];
  return typeof path === "string" ? parsePath(path) : path;
}
