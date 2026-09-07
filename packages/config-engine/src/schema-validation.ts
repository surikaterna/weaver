import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { deepEqual } from "./deep-equal";
import {
  validateArraySize,
  validateObjectSize,
  validateUniqueItems,
} from "./schema-validation-cardinality";
import { rejectUnsupportedComposition } from "./schema-validation-composition";
import {
  collectMemberSchemas,
  resolveMemberSchemas,
} from "./schema-validation-paths";
import {
  addBoundedError,
  addContextError,
  addError,
  compileSchemaPattern,
  describeTypes,
  describeValue,
  getEffectiveValue,
  hasOwn,
  isRecord,
  isSchemaArray,
  matchesAnyType,
  type SchemaValidationOptions,
  type SchemaValidationPathSegment,
  type SchemaValidationResult,
  toPathSegmentsResult,
  type ValidationContext,
  type ValidationMode,
  type ValidationState,
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

  const target = resolveMemberSchemas(
    schema,
    patchPath.segments,
    basePath.segments,
  );

  if (target.errors.length > 0 || target.schemas.length === 0) {
    return { valid: target.errors.length === 0, errors: target.errors };
  }

  const context: ValidationContext = { mode: "partial", errors: [] };
  const targetPath = [...basePath.segments, ...patchPath.segments];
  for (const targetSchema of target.schemas) {
    validateValue({ schema: targetSchema, value, path: targetPath, context });
  }
  return { valid: context.errors.length === 0, errors: context.errors };
}

function validateSchema(
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: ValidationMode,
  options?: SchemaValidationOptions,
): SchemaValidationResult {
  const path = toPathSegmentsResult(options?.path);
  if (path.error !== undefined) return invalidPathResult(path.error);

  const context: ValidationContext = { mode, errors: [] };
  validateValue({
    schema,
    value,
    path: path.segments,
    context,
  });
  return { valid: context.errors.length === 0, errors: context.errors };
}

function validateValue(state: ValidationState): void {
  if (rejectUnsupportedComposition(state.schema, state.path, state.context)) {
    return;
  }

  const value = getEffectiveValue(
    state.schema,
    state.value,
    state.context.mode,
  );

  if (value === undefined) {
    addError(state, "invalid-type", "Value must be defined", {
      expected: describeTypes(state.schema),
      actual: "undefined",
    });
    return;
  }

  if (!matchesAnyType(value, state.schema)) {
    addError(state, "invalid-type", "Value does not match schema type", {
      expected: describeTypes(state.schema),
      actual: describeValue(value),
    });
    return;
  }

  validateConstAndEnum({ ...state, value });
  validateByValueKind({ ...state, value });
}

function invalidPathResult(
  error: SchemaValidationResult["errors"][number],
): SchemaValidationResult {
  return { valid: false, errors: [error] };
}

function validateByValueKind(state: ValidationState): void {
  if (typeof state.value === "string") {
    validateStringConstraints(state);
  } else if (typeof state.value === "number") {
    validateNumberConstraints(state);
  } else if (Array.isArray(state.value)) {
    validateArraySchema(state.schema, state.value, state.path, state.context);
  } else if (isRecord(state.value)) {
    validateObjectSchema(state.schema, state.value, state.path, state.context);
  }
}

function validateObjectSchema(
  schema: ConfigurationPropertySchema,
  value: Record<string, unknown>,
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): void {
  validateObjectSize(schema, value, path, context);
  if (context.mode === "effective") {
    validateRequiredProperties(schema, value, path, context);
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const memberSchemas = collectMemberSchemas(schema, key, path, context);
    if (memberSchemas.length === 0) {
      validateAdditionalProperty(schema, key, nestedValue, path, context);
      continue;
    }

    for (const memberSchema of memberSchemas) {
      validateValue({
        schema: memberSchema,
        value: nestedValue,
        path: [...path, key],
        context,
      });
    }
  }
}

function validateRequiredProperties(
  schema: ConfigurationPropertySchema,
  value: Record<string, unknown>,
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): void {
  for (const key of schema.required ?? []) {
    if (hasOwn(value, key)) {
      continue;
    }

    const propertySchema = schema.properties?.[key];
    if (propertySchema?.default !== undefined) {
      validateValue({
        schema: propertySchema,
        value: undefined,
        path: [...path, key],
        context,
      });
      continue;
    }

    addContextError(context, "missing-required", [...path, key], {
      message: `Required property "${key}" is missing`,
    });
  }
}

function validateAdditionalProperty(
  schema: ConfigurationPropertySchema,
  key: string,
  value: unknown,
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): void {
  const additional = schema.additionalProperties;
  if (additional === true) {
    return;
  }
  if (additional === undefined || additional === false) {
    addContextError(context, "unknown-property", [...path, key], {
      message: `Unknown property "${key}" is not allowed`,
    });
    return;
  }
  validateValue({ schema: additional, value, path: [...path, key], context });
}

function validateArraySchema(
  schema: ConfigurationPropertySchema,
  value: readonly unknown[],
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): void {
  validateArraySize(schema, value, path, context);
  validateUniqueItems(schema, value, path, context);

  const items = schema.items;
  if (items === undefined) {
    return;
  }
  if (!isSchemaArray(items)) {
    validateHomogeneousItems(items, value, path, context);
    return;
  }
  validateTupleItems(items, value, path, context);
}

function validateHomogeneousItems(
  itemSchema: ConfigurationPropertySchema,
  value: readonly unknown[],
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): void {
  value.forEach((item, index) => {
    validateValue({
      schema: itemSchema,
      value: item,
      path: [...path, index],
      context,
    });
  });
}

function validateTupleItems(
  items: readonly ConfigurationPropertySchema[],
  value: readonly unknown[],
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): void {
  items.forEach((itemSchema, index) => {
    if (index < value.length) {
      validateValue({
        schema: itemSchema,
        value: value[index],
        path: [...path, index],
        context,
      });
    }
  });
}

function validateStringConstraints(state: ValidationState): void {
  const value = state.value;
  if (typeof value !== "string") return;
  addBoundedError(
    state,
    "minLength",
    value.length,
    state.schema.minLength,
    ">=",
  );
  addBoundedError(
    state,
    "maxLength",
    value.length,
    state.schema.maxLength,
    "<=",
  );
  if (state.schema.pattern !== undefined) {
    validatePattern(state.schema.pattern, value, state);
  }
}

function validateNumberConstraints(state: ValidationState): void {
  const value = state.value;
  if (typeof value !== "number") return;
  addBoundedError(state, "minimum", value, state.schema.minimum, ">=");
  addBoundedError(state, "maximum", value, state.schema.maximum, "<=");
  addBoundedError(
    state,
    "exclusiveMinimum",
    value,
    state.schema.exclusiveMinimum,
    ">",
  );
  addBoundedError(
    state,
    "exclusiveMaximum",
    value,
    state.schema.exclusiveMaximum,
    "<",
  );
  if (
    state.schema.multipleOf !== undefined &&
    !Number.isInteger(value / state.schema.multipleOf)
  ) {
    addError(
      state,
      "invalid-value",
      `Number must be a multiple of ${String(state.schema.multipleOf)}`,
    );
  }
}

function validateConstAndEnum(state: ValidationState): void {
  if (
    state.schema.const !== undefined &&
    !deepEqual(state.value, state.schema.const)
  ) {
    addError(state, "invalid-value", "Value does not match const constraint");
  }
  if (
    state.schema.enum !== undefined &&
    !state.schema.enum.some((item) => deepEqual(item, state.value))
  ) {
    addError(state, "invalid-value", "Value is not in the allowed enum values");
  }
}

function validatePattern(
  pattern: string,
  value: string,
  state: ValidationState,
): void {
  const regex = compileSchemaPattern(pattern, state.path, state.context);
  if (regex !== undefined && !regex.test(value)) {
    addError(
      state,
      "invalid-value",
      `String must match pattern ${JSON.stringify(pattern)}`,
    );
  }
}
