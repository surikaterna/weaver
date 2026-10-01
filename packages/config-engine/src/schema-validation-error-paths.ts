import { ownDataValue } from "./own-data";
import { parsePath } from "./path";
import type {
  PathSegmentsResult,
  SchemaValidationError,
  SchemaValidationErrorCode,
  SchemaValidationOptions,
  SchemaValidationPathSegment,
  ValidationErrorPath,
  ValidationPath,
} from "./schema-validation-support";

export function createValidationPath(
  base: readonly SchemaValidationPathSegment[],
): ValidationPath {
  return {
    kind: "validation-path",
    base,
    parent: undefined,
    segment: undefined,
  };
}

export function appendValidationPath(
  parent: ValidationPath,
  segment: SchemaValidationPathSegment,
): ValidationPath {
  return { kind: "validation-path", base: parent.base, parent, segment };
}

export function materializeValidationPath(
  path: ValidationErrorPath,
): readonly SchemaValidationPathSegment[] {
  if (Array.isArray(path)) return path;
  if (!isValidationPath(path)) return [];
  const suffix: SchemaValidationPathSegment[] = [];
  let cursor = path;
  let parent = cursor.parent;
  while (parent !== undefined) {
    const segment = cursor.segment;
    if (segment !== undefined) suffix.push(segment);
    cursor = parent;
    parent = cursor.parent;
  }
  suffix.reverse();
  return cursor.base.length === 0 ? suffix : [...cursor.base, ...suffix];
}

function isValidationPath(path: ValidationErrorPath): path is ValidationPath {
  return !Array.isArray(path);
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

export function validationOptionsPath(
  options: SchemaValidationOptions | undefined,
): PathSegmentsResult {
  if (options === undefined) return { segments: [] };
  if (
    options === null ||
    typeof options !== "object" ||
    !hasOwnDataDescriptors(options)
  ) {
    return {
      segments: [],
      error: makeError(
        "invalid-path",
        [],
        "Path options must be own plain data",
      ),
    };
  }
  const path = ownDataValue(options, "path");
  if (path === undefined || typeof path === "string" || Array.isArray(path))
    return toPathSegmentsResult(path);
  return {
    segments: [],
    error: makeError("invalid-path", [], "Invalid path options"),
  };
}

export function toPathSegmentsResult(
  path: string | readonly SchemaValidationPathSegment[] | undefined,
  errorSegments: readonly SchemaValidationPathSegment[] = [],
): PathSegmentsResult {
  if (path === undefined) return { segments: [] };
  if (typeof path !== "string")
    return toArrayPathSegmentsResult(path, errorSegments);
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
  if (!Array.isArray(path) || !hasOwnDataDescriptors(path)) {
    return {
      segments,
      error: makeError(
        "invalid-path",
        errorSegments,
        "Path must be an own plain data array",
      ),
    };
  }
  for (let index = 0; index < path.length; index++) {
    const segment = ownDataValue(path, index);
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

function isValidPathSegment(
  segment: unknown,
): segment is SchemaValidationPathSegment {
  return (
    typeof segment === "string" ||
    (typeof segment === "number" && Number.isFinite(segment))
  );
}

function hasOwnDataDescriptors(value: object): boolean {
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      if (
        Array.isArray(value) &&
        key !== "length" &&
        !/^(0|[1-9][0-9]*)$/.test(key)
      )
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    });
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPath(segments: readonly SchemaValidationPathSegment[]): string {
  let path = "$";
  for (const segment of segments) path += formatSegment(segment);
  return path;
}

function formatSegment(segment: SchemaValidationPathSegment): string {
  if (typeof segment === "number") return `[${String(segment)}]`;
  return /^[A-Za-z_$][\w$-]*$/.test(segment)
    ? `.${segment}`
    : `[${JSON.stringify(segment)}]`;
}
