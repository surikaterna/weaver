import { validateValueConstraints } from "./schema-validation-constraints";
import {
  allowsType,
  appendValidationPath,
  getEffectiveValue,
  matchesAnyType,
  type SchemaValidationPathSegment,
  type ValidationContext,
  type ValidationMode,
  type ValidationPath,
  type ValidationState,
} from "./schema-validation-support";

const PREDICATE_ERRORS: ValidationContext["errors"] = [];

export function createPredicateContext(
  mode: ValidationMode,
): ValidationContext {
  return {
    mode,
    errors: PREDICATE_ERRORS,
    predicateOnly: true,
    failed: false,
  };
}

export function appendContextPath(
  context: ValidationContext,
  path: ValidationPath,
  segment: SchemaValidationPathSegment,
): ValidationPath {
  return context.predicateOnly === true
    ? path
    : appendValidationPath(path, segment);
}

export function rejectPredicate(context: ValidationContext): boolean {
  if (context.predicateOnly !== true) return false;
  context.failed = true;
  return true;
}

export function validateScalarPredicate(
  state: ValidationState,
  predicateScalar: boolean,
): boolean {
  if (state.context.predicateOnly !== true || !predicateScalar) return false;
  if (allowsType(state.schema, "object") || allowsType(state.schema, "array")) {
    return false;
  }
  const value = getEffectiveValue(
    state.schema,
    state.value,
    state.context.mode,
  );
  if (value === undefined || !matchesAnyType(value, state.schema)) {
    state.context.failed = true;
    return true;
  }
  validateValueConstraints(value === state.value ? state : { ...state, value });
  return true;
}
