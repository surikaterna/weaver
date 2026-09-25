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
  type ValidationPath,
  type ValidationState,
} from "./schema-validation-support";
import { validateValueGraph } from "./schema-validation-value-graph";
import { validateValuesIteratively } from "./schema-validation-walk";

interface PreparedValidation {
  readonly baseSegments: readonly SchemaValidationPathSegment[];
  readonly path: ValidationPath;
  readonly plan: NonNullable<ReturnType<typeof validateSchemaGraph>>;
  readonly schema: ConfigurationPropertySchema;
}

type ValidationPreparation =
  | { readonly prepared: PreparedValidation }
  | { readonly error: SchemaValidationResult };

/** @internal Call-local validation plan for one configuration operation. */
export interface ConfigurationValidationSession {
  validateEffective(value: unknown): SchemaValidationResult;
  validatePartial(value: unknown): SchemaValidationResult;
  validatePatch(
    path: string | readonly SchemaValidationPathSegment[],
    value: unknown,
  ): SchemaValidationResult;
}

/** @internal Create a session that must not be retained across operations. */
export function createConfigurationValidationSession(
  schema: ConfigurationPropertySchema,
  options?: SchemaValidationOptions,
): ConfigurationValidationSession {
  const preparation = prepareValidation(schema, options);
  return {
    validateEffective: (value) =>
      validatePreparedValue(preparation, value, "effective"),
    validatePartial: (value) =>
      validatePreparedValue(preparation, value, "partial"),
    validatePatch: (path, value) =>
      validatePreparedPatch(preparation, path, value),
  };
}

function prepareValidation(
  schema: ConfigurationPropertySchema,
  options: SchemaValidationOptions | undefined,
): ValidationPreparation {
  const parsedPath = toPathSegmentsResult(options?.path);
  if (parsedPath.error !== undefined) {
    return { error: invalidPathResult(parsedPath.error) };
  }
  const context: ValidationContext = { mode: "partial", errors: [] };
  const path = createValidationPath(parsedPath.segments);
  const plan = validateSchemaGraph(schema, path, context);
  if (plan === undefined) return { error: result(context) };
  return {
    prepared: { baseSegments: parsedPath.segments, path, plan, schema },
  };
}

function validatePreparedValue(
  preparation: ValidationPreparation,
  value: unknown,
  mode: ValidationMode,
): SchemaValidationResult {
  if ("error" in preparation) return copyResult(preparation.error);
  const { path, plan, schema } = preparation.prepared;
  const context: ValidationContext = { mode, errors: [] };
  if (!validateValueGraph(value, path, context)) return result(context);
  validateValuesIteratively([{ schema, value, path, context }], plan);
  return result(context);
}

function validatePreparedPatch(
  preparation: ValidationPreparation,
  path: string | readonly SchemaValidationPathSegment[],
  value: unknown,
): SchemaValidationResult {
  if ("error" in preparation) return copyResult(preparation.error);
  const { baseSegments, plan, schema } = preparation.prepared;
  const patchPath = toPathSegmentsResult(path, baseSegments);
  if (patchPath.error !== undefined) return invalidPathResult(patchPath.error);
  const target = resolveMemberSchemas(schema, patchPath.segments, baseSegments);
  if (target.errors.length > 0) return { valid: false, errors: target.errors };
  return validatePatchTargets(
    plan,
    target.schemas,
    patchPath.segments,
    value,
    baseSegments,
  );
}

function validatePatchTargets(
  plan: PreparedValidation["plan"],
  schemas: readonly ConfigurationPropertySchema[],
  patchSegments: readonly SchemaValidationPathSegment[],
  value: unknown,
  baseSegments: readonly SchemaValidationPathSegment[],
): SchemaValidationResult {
  const context: ValidationContext = { mode: "partial", errors: [] };
  const path = createValidationPath([...baseSegments, ...patchSegments]);
  if (!validateValueGraph(value, path, context)) return result(context);
  const states = schemas.map<ValidationState>((schema) => ({
    schema,
    value,
    path,
    context,
  }));
  validateValuesIteratively(states, plan);
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

function copyResult(result: SchemaValidationResult): SchemaValidationResult {
  return { valid: result.valid, errors: [...result.errors] };
}
