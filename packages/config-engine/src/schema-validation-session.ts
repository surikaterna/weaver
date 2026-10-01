import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { validationOptionsPath } from "./schema-validation-error-paths";
import { validateSchemaGraph } from "./schema-validation-graph";
import { inspectValidationData } from "./schema-validation-input-guard";
import { ownField } from "./schema-validation-own-data";
import { resolveMemberSchemas } from "./schema-validation-paths";
import {
  captureSchemaStability,
  type SchemaStabilitySnapshot,
  schemaStabilityMatches,
} from "./schema-validation-schema-stability";
import {
  createValidationPath,
  makeError,
  type PathSegmentsResult,
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

interface PreparationState {
  readonly preparation: ValidationPreparation;
  readonly stability: SchemaStabilitySnapshot;
}

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
  const basePath = validationOptionsPath(options);
  let state: PreparationState | undefined;
  const currentPreparation = (): ValidationPreparation => {
    const pathError = ownField(basePath, "error");
    if (pathError !== undefined) return { error: invalidPathResult(pathError) };
    const data = inspectValidationData(schema, "schema");
    if (!data.safe) return { error: unsafeSchemaResult(basePath.segments) };
    if (state !== undefined && schemaStabilityMatches(state.stability)) {
      if (data.cyclic && Object.hasOwn(state.preparation, "prepared"))
        return { error: unsafeSchemaResult(basePath.segments) };
      return state.preparation;
    }
    state = createPreparationState(schema, basePath);
    return state.preparation;
  };
  return {
    validateEffective: (value) =>
      validatePreparedValue(currentPreparation(), value, "effective"),
    validatePartial: (value) =>
      validatePreparedValue(currentPreparation(), value, "partial"),
    validatePatch: (path, value) =>
      validatePreparedPatch(currentPreparation(), path, value),
  };
}

function createPreparationState(
  schema: ConfigurationPropertySchema,
  basePath: PathSegmentsResult,
): PreparationState {
  const preparation = prepareValidation(schema, basePath);
  return {
    preparation,
    stability: captureSchemaStability(schema),
  };
}

function prepareValidation(
  schema: ConfigurationPropertySchema,
  parsedPath: PathSegmentsResult,
): ValidationPreparation {
  const pathError = ownField(parsedPath, "error");
  if (pathError !== undefined) {
    return { error: invalidPathResult(pathError) };
  }
  const context: ValidationContext = { mode: "partial", errors: [] };
  const path = createValidationPath(parsedPath.segments);
  const data = inspectValidationData(schema, "schema");
  if (!data.safe) return { error: unsafeSchemaResult(parsedPath.segments) };
  const plan = validateSchemaGraph(schema, path, context);
  if (plan === undefined) return { error: result(context) };
  if (data.cyclic) return { error: unsafeSchemaResult(parsedPath.segments) };
  return {
    prepared: { baseSegments: parsedPath.segments, path, plan, schema },
  };
}

function unsafeSchemaResult(
  segments: readonly SchemaValidationPathSegment[],
): SchemaValidationResult {
  return {
    valid: false,
    errors: [
      makeError(
        "invalid-schema",
        segments,
        "Schema must contain only acyclic own plain data",
      ),
    ],
  };
}

function validatePreparedValue(
  preparation: ValidationPreparation,
  value: unknown,
  mode: ValidationMode,
): SchemaValidationResult {
  if (isFailedPreparation(preparation)) return copyResult(preparation.error);
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
  if (isFailedPreparation(preparation)) return copyResult(preparation.error);
  const { baseSegments, plan, schema } = preparation.prepared;
  const patchPath = toPathSegmentsResult(path, baseSegments);
  const pathError = ownField(patchPath, "error");
  if (pathError !== undefined) return invalidPathResult(pathError);
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

function isFailedPreparation(
  preparation: ValidationPreparation,
): preparation is { readonly error: SchemaValidationResult } {
  return Object.hasOwn(preparation, "error");
}
