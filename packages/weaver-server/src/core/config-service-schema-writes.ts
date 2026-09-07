import type {
  SchemaValidationError,
  SchemaValidationPathSegment,
  SchemaValidationResult,
} from "@weaver-conf/config-engine";
import {
  assertPublicConfigPath,
  parseCanonicalConfigPath,
  validateConfigurationPatch,
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";
import type {
  EffectiveValidationContext,
  SchemaWriteContext,
} from "./config-service-types";
import type { RegisteredSchemaAnchor } from "./schema-registry";

export interface PreparedSchemaWrite {
  readonly success: true;
  readonly anchorPath: string;
  readonly key: string;
  readonly value: unknown;
}

export type SchemaWritePreparation = PreparedSchemaWrite | FailedSchemaWrite;

interface FailedSchemaWrite {
  readonly success: false;
  readonly result: WriteResult;
}

export async function prepareRegisteredObjectWrite(
  path: string,
  value: unknown,
  options: SchemaWriteContext,
  defaultEnvironment: string,
): Promise<SchemaWritePreparation> {
  const resolved = await resolveWriteAnchor(path, options, defaultEnvironment);
  if (!resolved.success) return resolved;
  if (resolved.path !== resolved.anchor.path) {
    return writeFailure(
      "Object writes must target a registered schema anchor",
      {
        path: resolved.path,
        anchorPath: resolved.anchor.path,
        environment: resolved.environment,
      },
    );
  }

  const validation = validatePartialConfiguration(
    resolved.anchor.schema,
    value,
    {
      path: resolved.segments,
    },
  );
  if (!validation.valid) return validationFailure(validation, resolved);
  return preparedWrite(resolved.anchor.path, value);
}

export async function prepareRegisteredPatchWrite(
  path: string,
  value: unknown,
  options: SchemaWriteContext,
  defaultEnvironment: string,
  getLayerValue: (key: string) => Promise<unknown>,
): Promise<SchemaWritePreparation> {
  const resolved = await resolveWriteAnchor(path, options, defaultEnvironment);
  if (!resolved.success) return resolved;

  const relativeSegments = relativePathSegments(
    resolved.anchor.path,
    resolved.path,
  );
  if (relativeSegments.length === 0) {
    return writeFailure(
      "Patches must target a path below a registered anchor",
      {
        path: resolved.path,
        anchorPath: resolved.anchor.path,
        environment: resolved.environment,
      },
    );
  }
  const patchValidation = validateConfigurationPatch(
    resolved.anchor.schema,
    relativeSegments,
    value,
    { path: parseCanonicalConfigPath(resolved.anchor.path).segments },
  );
  if (!patchValidation.valid)
    return validationFailure(patchValidation, resolved);

  const anchorKey = parseCanonicalConfigPath(resolved.anchor.path).storageKey;
  const baseValue = await getLayerValue(anchorKey);
  const baseValidation = validateExistingLayerValue(baseValue, resolved);
  if (!baseValidation.success) return baseValidation;

  const nextValue = patchLayerObject(baseValue, relativeSegments, value);
  const resultValidation = validatePartialConfiguration(
    resolved.anchor.schema,
    nextValue,
    { path: parseCanonicalConfigPath(resolved.anchor.path).segments },
  );
  if (!resultValidation.valid)
    return validationFailure(resultValidation, resolved);
  return {
    success: true,
    anchorPath: resolved.anchor.path,
    key: anchorKey,
    value: nextValue,
  };
}

export async function validateRegisteredEffectiveConfiguration(
  path: string,
  options: EffectiveValidationContext,
  defaultEnvironment: string,
  getEffectiveValue: (key: string) => Promise<unknown>,
): Promise<SchemaValidationResult> {
  const environment = options.environment ?? defaultEnvironment;
  const normalized = normalizeCanonicalPath(path);
  if (!normalized.success) return invalidPathValidation(normalized.message);

  const anchor = await options.schemaRegistry.resolveAnchor(
    normalized.path,
    environment,
  );
  if (anchor === null || anchor.path !== normalized.path) {
    return invalidPathValidation(
      `No registered schema anchor for path "${normalized.path}" in environment "${environment}"`,
      normalized.segments,
    );
  }

  const value = await getEffectiveValue(
    parseCanonicalConfigPath(anchor.path).storageKey,
  );
  return validateEffectiveConfiguration(anchor.schema, value, {
    path: normalized.segments,
  });
}

interface ResolvedWriteAnchor {
  readonly success: true;
  readonly anchor: RegisteredSchemaAnchor;
  readonly environment: string;
  readonly path: string;
  readonly segments: readonly string[];
}

type WriteAnchorResolution = ResolvedWriteAnchor | FailedSchemaWrite;

async function resolveWriteAnchor(
  path: string,
  options: SchemaWriteContext,
  defaultEnvironment: string,
): Promise<WriteAnchorResolution> {
  const environment = options.environment ?? defaultEnvironment;
  const normalized = normalizeCanonicalPath(path);
  if (!normalized.success) return writeFailure(normalized.message, { path });

  const anchor = await options.schemaRegistry.resolveAnchor(
    normalized.path,
    environment,
  );
  if (anchor === null) {
    return writeFailure(
      `No registered schema anchor for path "${normalized.path}" in environment "${environment}"`,
      { path: normalized.path, environment },
    );
  }

  return {
    success: true,
    anchor,
    environment,
    path: normalized.path,
    segments: normalized.segments,
  };
}

function validateExistingLayerValue(
  value: unknown,
  resolved: ResolvedWriteAnchor,
): SchemaWritePreparation {
  if (value === undefined)
    return { success: true, anchorPath: resolved.anchor.path, key: "", value };
  const validation = validatePartialConfiguration(
    resolved.anchor.schema,
    value,
    {
      path: parseCanonicalConfigPath(resolved.anchor.path).segments,
    },
  );
  return validation.valid
    ? { success: true, anchorPath: resolved.anchor.path, key: "", value }
    : validationFailure(validation, resolved);
}

function validationFailure(
  validation: SchemaValidationResult,
  resolved: ResolvedWriteAnchor,
): SchemaWritePreparation {
  return writeFailure("Configuration does not match registered schema", {
    path: resolved.path,
    anchorPath: resolved.anchor.path,
    environment: resolved.environment,
    errors: validation.errors,
  });
}

function preparedWrite(
  anchorPath: string,
  value: unknown,
): PreparedSchemaWrite {
  return {
    success: true,
    anchorPath,
    key: parseCanonicalConfigPath(anchorPath).storageKey,
    value,
  };
}

function writeFailure(
  message: string,
  details: Record<string, unknown>,
): FailedSchemaWrite {
  return {
    success: false,
    result: {
      success: false,
      error: { code: "VALIDATION_ERROR", message, details },
    },
  };
}

function normalizeCanonicalPath(path: string):
  | {
      readonly success: true;
      readonly path: string;
      readonly segments: readonly string[];
    }
  | { readonly success: false; readonly message: string } {
  try {
    const normalized = assertPublicConfigPath(path);
    if (normalized.includes("[") || normalized.includes("]")) {
      return {
        success: false,
        message: `Path "${normalized}" must use canonical slash segments`,
      };
    }
    const segments = parseCanonicalConfigPath(normalized).segments;
    if (segments.length === 0) {
      return {
        success: false,
        message: "Configuration writes must not target root",
      };
    }
    return { success: true, path: normalized, segments };
  } catch (error: unknown) {
    return { success: false, message: errorMessage(error) };
  }
}

function relativePathSegments(
  anchorPath: string,
  path: string,
): readonly string[] {
  const anchorSegments = parseCanonicalConfigPath(anchorPath).segments;
  return parseCanonicalConfigPath(path).segments.slice(anchorSegments.length);
}

function patchLayerObject(
  baseValue: unknown,
  segments: readonly string[],
  value: unknown,
): unknown {
  const root = baseValue === undefined ? {} : structuredClone(baseValue);
  if (segments.length === 0) return value;
  setMemberValue(root, segments, value);
  return root;
}

function setMemberValue(
  root: unknown,
  segments: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      assignMember(current, segment, value);
      return;
    }
    current = ensureContainer(current, segment, segments[index + 1]);
  }
}

function ensureContainer(
  current: unknown,
  segment: string,
  nextSegment: string | undefined,
): unknown {
  const existing = readMember(current, segment);
  if (isRecord(existing) || Array.isArray(existing)) return existing;
  const next = isArrayIndex(nextSegment) ? [] : {};
  assignMember(current, segment, next);
  return next;
}

function readMember(current: unknown, segment: string): unknown {
  if (Array.isArray(current) && isArrayIndex(segment))
    return current[Number(segment)];
  if (isRecord(current) && Object.hasOwn(current, segment))
    return current[segment];
  return undefined;
}

function assignMember(current: unknown, segment: string, value: unknown): void {
  if (Array.isArray(current) && isArrayIndex(segment)) {
    current[Number(segment)] = value;
    return;
  }
  if (isRecord(current)) current[segment] = value;
}

function invalidPathValidation(
  message: string,
  segments: readonly SchemaValidationPathSegment[] = [],
): SchemaValidationResult {
  return {
    valid: false,
    errors: [schemaValidationError("invalid-path", message, segments)],
  };
}

function schemaValidationError(
  code: SchemaValidationError["code"],
  message: string,
  segments: readonly SchemaValidationPathSegment[],
): SchemaValidationError {
  return { code, message, segments: [...segments], path: formatPath(segments) };
}

function formatPath(segments: readonly SchemaValidationPathSegment[]): string {
  let path = "$";
  for (const segment of segments) path += `.${String(segment)}`;
  return path;
}

function isArrayIndex(segment: string | undefined): boolean {
  if (segment === undefined) return false;
  const index = Number(segment);
  return Number.isInteger(index) && index >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
