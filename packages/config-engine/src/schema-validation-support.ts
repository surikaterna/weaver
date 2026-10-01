import type {
  ConfigurationJsonSchemaType,
  ConfigurationPropertySchema,
} from "@weaver-conf/config-types";

import { defineOwnData, pushOwn } from "./own-data";
import { getCachedRegex, isSafePattern } from "./regex-cache";
import {
  makeError,
  materializeValidationPath,
} from "./schema-validation-error-paths";
import { ownField } from "./schema-validation-own-data";

export {
  appendValidationPath,
  createValidationPath,
  makeError,
  materializeValidationPath,
  toPathSegmentsResult,
} from "./schema-validation-error-paths";

export type SchemaValidationPathSegment = string | number;

export interface ValidationPath {
  readonly kind: "validation-path";
  readonly base: readonly SchemaValidationPathSegment[];
  readonly parent?: ValidationPath | undefined;
  readonly segment?: SchemaValidationPathSegment | undefined;
}

export type ValidationErrorPath =
  | readonly SchemaValidationPathSegment[]
  | ValidationPath;

export type SchemaValidationErrorCode =
  | "invalid-type"
  | "invalid-value"
  | "missing-required"
  | "unknown-property"
  | "invalid-path"
  | "invalid-schema";

export interface SchemaValidationError {
  readonly code: SchemaValidationErrorCode;
  readonly path: string;
  readonly segments: readonly SchemaValidationPathSegment[];
  readonly message: string;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaValidationError[];
}

export interface SchemaValidationOptions {
  readonly path?: string | readonly SchemaValidationPathSegment[] | undefined;
}

export type ValidationMode = "partial" | "effective";

export interface ValidationContext {
  mode: ValidationMode;
  errors: SchemaValidationError[];
  readonly predicateOnly?: true;
  failed?: boolean;
}

export interface ValidationState {
  schema: ConfigurationPropertySchema;
  value: unknown;
  path: ValidationPath;
  context: ValidationContext;
}

export interface MemberSchemaResult {
  schemas: ConfigurationPropertySchema[];
  errors: SchemaValidationError[];
}

export interface PathSegmentsResult {
  segments: readonly SchemaValidationPathSegment[];
  error?: SchemaValidationError | undefined;
}

export function addError(
  state: ValidationState,
  code: SchemaValidationErrorCode,
  message: string,
  details?: Pick<SchemaValidationError, "expected" | "actual">,
): void {
  if (ownField(state.context, "predicateOnly") === true) {
    defineOwnData(state.context, "failed", true);
    return;
  }
  addContextError(state.context, code, state.path, { message, ...details });
}

export function addContextError(
  context: ValidationContext,
  code: SchemaValidationErrorCode,
  path: ValidationErrorPath,
  details: {
    message: string;
    expected?: string | undefined;
    actual?: string | undefined;
  },
): void {
  if (ownField(context, "predicateOnly") === true) {
    defineOwnData(context, "failed", true);
    return;
  }
  pushOwn(
    context.errors,
    makeError(code, materializeValidationPath(path), details.message, details),
  );
}

export function addBoundedError(
  state: ValidationState,
  name: string,
  actual: number,
  expected: number | undefined,
  operator: string,
): void {
  addBoundedContextError(
    state.context,
    state.path,
    name,
    actual,
    expected,
    operator,
  );
}

export function addBoundedContextError(
  context: ValidationContext,
  path: ValidationErrorPath,
  name: string,
  actual: number,
  expected: number | undefined,
  operator: string,
): void {
  if (expected === undefined || boundPasses(actual, expected, operator)) return;
  if (ownField(context, "predicateOnly") === true) {
    defineOwnData(context, "failed", true);
    return;
  }
  addContextError(context, "invalid-value", path, {
    message: `${name} requires ${String(actual)} ${operator} ${String(expected)}`,
  });
}

export function compileSchemaPattern(
  pattern: string,
  path: ValidationErrorPath,
  context: ValidationContext,
): RegExp | undefined {
  if (!isSafePattern(pattern)) {
    addContextError(context, "invalid-schema", path, {
      message: `Unsafe regex pattern ${JSON.stringify(pattern)}`,
    });
    return undefined;
  }
  try {
    return getCachedRegex(pattern);
  } catch (error: unknown) {
    addContextError(context, "invalid-schema", path, {
      message: `Invalid regex pattern: ${String(error)}`,
    });
    return undefined;
  }
}

export function getEffectiveValue(
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: ValidationMode,
): unknown {
  const fallback = ownField(schema, "default");
  return mode === "effective" && value === undefined && fallback !== undefined
    ? fallback
    : value;
}

export function matchesAnyType(
  value: unknown,
  schema: ConfigurationPropertySchema,
): boolean {
  const types = ownField(schema, "type");
  if (types === undefined) return false;
  if (!isSchemaTypeArray(types)) return matchesType(value, types);
  for (let index = 0; index < types.length; index++) {
    const type = ownField(types, index);
    if (type !== undefined && matchesType(value, type)) return true;
  }
  return false;
}

export function allowsType(
  schema: ConfigurationPropertySchema,
  type: ConfigurationJsonSchemaType,
): boolean {
  const types = ownField(schema, "type");
  if (types === undefined) return false;
  if (!isSchemaTypeArray(types)) return types === type;
  for (let index = 0; index < types.length; index++) {
    if (ownField(types, index) === type) return true;
  }
  return false;
}

export function getTypes(
  schema: ConfigurationPropertySchema,
): readonly ConfigurationJsonSchemaType[] {
  const types = ownField(schema, "type");
  if (types === undefined) return [];
  return isSchemaTypeArray(types) ? types : [types];
}

export function describeTypes(schema: ConfigurationPropertySchema): string {
  const types = getTypes(schema);
  let result = "";
  for (let index = 0; index < types.length; index++) {
    result += `${index === 0 ? "" : " | "}${ownField(types, index) ?? ""}`;
  }
  return result;
}

export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function getArrayIndex(
  segment: SchemaValidationPathSegment,
): number | undefined {
  if (typeof segment === "number") {
    return Number.isSafeInteger(segment) &&
      segment >= 0 &&
      !Object.is(segment, -0)
      ? boundedArrayIndex(segment)
      : undefined;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
  return boundedArrayIndex(Number(segment));
}

function boundedArrayIndex(index: number): number | undefined {
  return Number.isSafeInteger(index) && index <= 4_294_967_294
    ? index
    : undefined;
}

export function isSchemaArray(
  value: ConfigurationPropertySchema | readonly ConfigurationPropertySchema[],
): value is readonly ConfigurationPropertySchema[] {
  return Array.isArray(value);
}

function matchesType(
  value: unknown,
  type: ConfigurationJsonSchemaType,
): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function isSchemaTypeArray(
  value: ConfigurationJsonSchemaType | readonly ConfigurationJsonSchemaType[],
): value is readonly ConfigurationJsonSchemaType[] {
  return Array.isArray(value);
}

function boundPasses(
  actual: number,
  expected: number,
  operator: string,
): boolean {
  if (operator === ">=") return actual >= expected;
  if (operator === "<=") return actual <= expected;
  if (operator === ">") return actual > expected;
  return actual < expected;
}
