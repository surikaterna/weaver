import type {
  ConfigurationJsonSchemaType,
  ConfigurationPropertySchema,
} from "@weaver-conf/config-types";

import { parsePath } from "./path";
import { getCachedRegex, isSafePattern } from "./regex-cache";

export type SchemaValidationPathSegment = string | number;

export type SchemaValidationErrorCode =
  | "invalid-type"
  | "invalid-value"
  | "missing-required"
  | "unknown-property"
  | "invalid-path"
  | "invalid-schema";

export interface SchemaValidationError {
  code: SchemaValidationErrorCode;
  path: string;
  segments: readonly SchemaValidationPathSegment[];
  message: string;
  expected?: string | undefined;
  actual?: string | undefined;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

export interface SchemaValidationOptions {
  path?: string | readonly SchemaValidationPathSegment[] | undefined;
}

export type ValidationMode = "partial" | "effective";

export interface ValidationContext {
  mode: ValidationMode;
  errors: SchemaValidationError[];
}

export interface ValidationState {
  schema: ConfigurationPropertySchema;
  value: unknown;
  path: readonly SchemaValidationPathSegment[];
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
  addContextError(state.context, code, state.path, { message, ...details });
}

export function addContextError(
  context: ValidationContext,
  code: SchemaValidationErrorCode,
  path: readonly SchemaValidationPathSegment[],
  details: {
    message: string;
    expected?: string | undefined;
    actual?: string | undefined;
  },
): void {
  context.errors.push(makeError(code, path, details.message, details));
}

export function makeError(
  code: SchemaValidationErrorCode,
  segments: readonly SchemaValidationPathSegment[],
  message: string,
  details?: Pick<SchemaValidationError, "expected" | "actual">,
): SchemaValidationError {
  return {
    code,
    path: formatPath(segments),
    segments: [...segments],
    message,
    ...details,
  };
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
  path: readonly SchemaValidationPathSegment[],
  name: string,
  actual: number,
  expected: number | undefined,
  operator: string,
): void {
  if (expected === undefined || boundPasses(actual, expected, operator)) return;
  addContextError(context, "invalid-value", path, {
    message: `${name} requires ${String(actual)} ${operator} ${String(expected)}`,
  });
}

export function compileSchemaPattern(
  pattern: string,
  path: readonly SchemaValidationPathSegment[],
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
  return mode === "effective" &&
    value === undefined &&
    schema.default !== undefined
    ? schema.default
    : value;
}

export function matchesAnyType(
  value: unknown,
  schema: ConfigurationPropertySchema,
): boolean {
  return getTypes(schema).some((type) => matchesType(value, type));
}

export function allowsType(
  schema: ConfigurationPropertySchema,
  type: ConfigurationJsonSchemaType,
): boolean {
  return getTypes(schema).includes(type);
}

export function getTypes(
  schema: ConfigurationPropertySchema,
): readonly ConfigurationJsonSchemaType[] {
  return isSchemaTypeArray(schema.type) ? schema.type : [schema.type];
}

export function describeTypes(schema: ConfigurationPropertySchema): string {
  return getTypes(schema).join(" | ");
}

export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function toPathSegments(
  path: string | readonly SchemaValidationPathSegment[] | undefined,
): readonly SchemaValidationPathSegment[] {
  if (path === undefined) return [];
  return typeof path === "string" ? parsePath(path) : validPathPrefix(path);
}

export function toPathSegmentsResult(
  path: string | readonly SchemaValidationPathSegment[] | undefined,
  errorSegments: readonly SchemaValidationPathSegment[] = [],
): PathSegmentsResult {
  if (path === undefined) return { segments: [] };
  if (typeof path !== "string") {
    return toArrayPathSegmentsResult(path, errorSegments);
  }

  try {
    return { segments: parsePath(path) };
  } catch (error: unknown) {
    return {
      segments: [],
      error: makeError(
        "invalid-path",
        errorSegments,
        `Invalid path: ${errorMessage(error)}`,
      ),
    };
  }
}

function toArrayPathSegmentsResult(
  path: readonly unknown[],
  errorSegments: readonly SchemaValidationPathSegment[],
): PathSegmentsResult {
  const segments: SchemaValidationPathSegment[] = [];
  for (const [index, segment] of path.entries()) {
    if (isValidPathSegment(segment)) {
      segments.push(segment);
      continue;
    }

    return {
      segments,
      error: makeError(
        "invalid-path",
        [...errorSegments, ...segments],
        `Invalid path segment at index ${String(index)}: expected string or finite number`,
      ),
    };
  }
  return { segments };
}

function validPathPrefix(
  path: readonly unknown[],
): SchemaValidationPathSegment[] {
  const segments: SchemaValidationPathSegment[] = [];
  for (const segment of path) {
    if (!isValidPathSegment(segment)) return segments;
    segments.push(segment);
  }
  return segments;
}

function isValidPathSegment(
  segment: unknown,
): segment is SchemaValidationPathSegment {
  return typeof segment === "string" || isFiniteNumber(segment);
}

function isFiniteNumber(segment: unknown): segment is number {
  return typeof segment === "number" && Number.isFinite(segment);
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
  const index = typeof segment === "number" ? segment : Number(segment);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function formatPath(segments: readonly SchemaValidationPathSegment[]): string {
  let path = "$";
  for (const segment of segments) {
    path += formatSegment(segment);
  }
  return path;
}

function formatSegment(segment: SchemaValidationPathSegment): string {
  if (typeof segment === "number") return `[${String(segment)}]`;
  return /^[A-Za-z_$][\w$-]*$/.test(segment)
    ? `.${segment}`
    : `[${JSON.stringify(segment)}]`;
}
