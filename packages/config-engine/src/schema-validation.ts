import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { validateSchemaGraph } from "./schema-validation-graph";
import { resolveMemberSchemas } from "./schema-validation-paths";
import {
  createValidationPath,
  type SchemaValidationOptions,
  type SchemaValidationPathSegment,
  type SchemaValidationResult,
  toPathSegmentsResult,
  type ValidationContext,
  type ValidationMode,
  type ValidationState,
} from "./schema-validation-support";
import { validateValueGraph } from "./schema-validation-value-graph";
import { validateValuesIteratively } from "./schema-validation-walk";

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
  return validateSchema(schema, value, "partial", options);
}

export function validateEffectiveConfiguration(
  schema: ConfigurationPropertySchema,
  value: unknown,
  options?: SchemaValidationOptions,
): SchemaValidationResult {
  return validateSchema(schema, value, "effective", options);
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

  const context: ValidationContext = { mode: "partial", errors: [] };
  const schemaPath = createValidationPath(basePath.segments);
  const plan = validateSchemaGraph(schema, schemaPath, context);
  if (plan === undefined) return result(context);
  const target = resolveMemberSchemas(
    schema,
    patchPath.segments,
    basePath.segments,
  );
  if (target.errors.length > 0) return { valid: false, errors: target.errors };

  const targetSegments = [...basePath.segments, ...patchPath.segments];
  const targetPath = createValidationPath(targetSegments);
  if (!validateValueGraph(value, targetPath, context)) return result(context);
  if (target.schemas.length === 0) return result(context);
  const states = target.schemas.map<ValidationState>((targetSchema) => ({
    schema: targetSchema,
    value,
    path: targetPath,
    context,
  }));
  validateValuesIteratively(states, plan);
  return result(context);
}

function validateSchema(
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: ValidationMode,
  options?: SchemaValidationOptions,
): SchemaValidationResult {
  const parsedPath = toPathSegmentsResult(options?.path);
  if (parsedPath.error !== undefined)
    return invalidPathResult(parsedPath.error);
  const context: ValidationContext = { mode, errors: [] };
  const path = createValidationPath(parsedPath.segments);
  const plan = validateSchemaGraph(schema, path, context);
  if (plan === undefined) return result(context);
  if (!validateValueGraph(value, path, context)) return result(context);
  validateValuesIteratively([{ schema, value, path, context }], plan);
  return result(context);
}

function result(context: ValidationContext): SchemaValidationResult {
  return { valid: context.errors.length === 0, errors: context.errors };
}

function invalidPathResult(
  error: SchemaValidationResult["errors"][number],
): SchemaValidationResult {
  return { valid: false, errors: [error] };
}
