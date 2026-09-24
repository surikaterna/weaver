import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import type {
  SchemaValidationError,
  SchemaValidationResult,
} from "../../src/schema-validation.js";
import type { RawError } from "./types.js";

export function normalizeErrors(
  errors: readonly unknown[],
  schema: ConfigurationPropertySchema,
): SchemaValidationResult {
  const normalized = errors.map((error) =>
    normalizeError(toRawError(error), schema),
  );
  return { valid: normalized.length === 0, errors: normalized };
}

export function comparableResult(result: SchemaValidationResult): string {
  return JSON.stringify({
    valid: result.valid,
    errors: result.errors.map(({ code, path }) => ({ code, path })),
  });
}

export function prefixResult(
  result: SchemaValidationResult,
  prefix: readonly (string | number)[],
): SchemaValidationResult {
  if (prefix.length === 0 || result.valid) return result;
  return {
    valid: false,
    errors: result.errors.map((error) => {
      const segments = [...prefix, ...error.segments];
      return { ...error, segments, path: formatPath(segments) };
    }),
  };
}

export function toRawError(value: unknown): RawError {
  if (!isRecord(value))
    return { keyword: "unknown", instancePath: "", message: String(value) };
  const keyword =
    stringField(value, "keyword") ??
    keywordFromLocation(stringField(value, "keywordLocation"));
  return {
    keyword: keyword ?? "unknown",
    instancePath:
      stringField(value, "instancePath") ??
      stringField(value, "instanceLocation") ??
      "",
    message:
      stringField(value, "message") ??
      stringField(value, "error") ??
      "Validation failed",
    params: recordField(value, "params"),
    schemaPath:
      stringField(value, "schemaPath") ?? stringField(value, "keywordLocation"),
  };
}

function normalizeError(
  raw: RawError,
  schema: ConfigurationPropertySchema,
): SchemaValidationError {
  const segments = pointerSegments(raw.instancePath);
  appendParamSegment(raw, segments);
  const code = errorCode(raw.keyword);
  return {
    code,
    path: formatPath(segments),
    segments,
    message: normalizedMessage(raw),
    ...(raw.keyword === "type"
      ? { expected: String(schema.type), actual: "candidate-value" }
      : {}),
  };
}

function appendParamSegment(
  raw: RawError,
  segments: Array<string | number>,
): void {
  if (raw.keyword === "required") {
    const missing = raw.params?.missingProperty;
    if (typeof missing === "string") segments.push(missing);
  }
  if (raw.keyword === "additionalProperties") {
    const property = raw.params?.additionalProperty;
    if (typeof property === "string") segments.push(property);
  }
}

function errorCode(keyword: string): SchemaValidationError["code"] {
  if (keyword === "type") return "invalid-type";
  if (keyword === "required") return "missing-required";
  if (keyword === "additionalProperties") return "unknown-property";
  return keyword === "schema" ? "invalid-schema" : "invalid-value";
}

function normalizedMessage(raw: RawError): string {
  if (raw.keyword === "type") return "Value does not match schema type";
  if (raw.keyword === "required")
    return `Required property is missing: ${raw.message}`;
  if (raw.keyword === "additionalProperties")
    return `Unknown property is not allowed: ${raw.message}`;
  return `${raw.keyword}: ${raw.message}`;
}

function pointerSegments(pointer: string): Array<string | number> {
  if (pointer === "" || pointer === "#") return [];
  const raw = pointer.replace(/^#?\//, "").split("/");
  return raw.map((segment) => {
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return /^(?:0|[1-9][0-9]*)$/.test(decoded) ? Number(decoded) : decoded;
  });
}

function formatPath(segments: readonly (string | number)[]): string {
  let path = "$";
  for (const segment of segments) {
    path +=
      typeof segment === "number"
        ? `[${String(segment)}]`
        : formatStringSegment(segment);
  }
  return path;
}

function formatStringSegment(segment: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(segment)
    ? `.${segment}`
    : `[${JSON.stringify(segment)}]`;
}

function keywordFromLocation(location: string | undefined): string | undefined {
  return location?.split("/").at(-1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}
