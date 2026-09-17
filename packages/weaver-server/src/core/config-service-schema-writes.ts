import type {
  CanonicalConfigPath,
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
import type { ScopeInstance, WriteResult } from "@weaver-conf/config-types";
import type {
  EffectiveValidationContext,
  SchemaWriteContext,
  WeaverConfigService,
} from "./config-service-types";
import { protectedConfigMutationError } from "./protected-config-paths";
import type { RegisteredSchemaAnchor } from "./schema-registry";

export interface PreparedSchemaWrite {
  readonly success: true;
  readonly key: string;
  readonly value: unknown;
}

export type SchemaWritePreparation = PreparedSchemaWrite | FailedSchemaWrite;

interface FailedSchemaWrite {
  readonly success: false;
  readonly result: WriteResult;
}

interface RegisteredWriteOperationsOptions {
  readonly defaultEnvironment: string;
  readonly getLayerValue: (layer: string, key: string) => Promise<unknown>;
  readonly get: (
    key: string,
    options?: { scopePath?: ScopeInstance[] },
  ) => Promise<unknown>;
  readonly set: WeaverConfigService["set"];
  readonly isInternalWrite: (options: SchemaWriteContext) => boolean;
  readonly checkRevision: (expected: string | undefined) => WriteResult | null;
}

type RegisteredWriteOperations = Pick<
  WeaverConfigService,
  "setRegisteredObject" | "patchRegisteredPath" | "validateRegisteredEffective"
>;

export function createRegisteredWriteOperations(
  options: RegisteredWriteOperationsOptions,
): RegisteredWriteOperations {
  return {
    async setRegisteredObject(layer, path, value, context) {
      const failure = registeredWritePreflight(options, path, context);
      if (failure !== null) return failure;
      const prepared = await prepareRegisteredObjectWrite(
        path,
        value,
        context,
        options.defaultEnvironment,
      );
      if (!prepared.success) return prepared.result;
      return options.set(layer, prepared.key, prepared.value, context);
    },
    async patchRegisteredPath(layer, path, value, context) {
      const failure = registeredWritePreflight(options, path, context);
      if (failure !== null) return failure;
      const prepared = await prepareRegisteredPatchWrite(
        path,
        value,
        context,
        options.defaultEnvironment,
        (key) => options.getLayerValue(layer, key),
      );
      if (!prepared.success) return prepared.result;
      return options.set(layer, prepared.key, prepared.value, context);
    },
    validateRegisteredEffective(path, context) {
      const getOptions = context.scopePath
        ? { scopePath: context.scopePath }
        : undefined;
      return validateRegisteredEffectiveConfiguration(
        path,
        context,
        options.defaultEnvironment,
        (key) => options.get(key, getOptions),
      );
    },
  };
}

function registeredWritePreflight(
  operations: RegisteredWriteOperationsOptions,
  path: string,
  context: SchemaWriteContext,
): WriteResult | null {
  if (!operations.isInternalWrite(context)) {
    const protectedError = protectedConfigMutationError(path);
    if (protectedError !== null) return protectedError;
  }
  return operations.checkRevision(context.expectedRevision);
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
    { path: resolved.segments },
  );
  if (!validation.valid) return validationFailure(validation, resolved);
  return preparedWrite(resolved.anchor, value);
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
  const anchor = parseCanonicalConfigPath(resolved.anchor.path);
  const relativeSegments = resolved.segments.slice(anchor.segments.length);
  const targetFailure = validatePatchTarget(resolved, relativeSegments);
  if (targetFailure !== null) return targetFailure;
  const patchValidation = validateConfigurationPatch(
    resolved.anchor.schema,
    relativeSegments,
    value,
    { path: anchor.segments },
  );
  if (!patchValidation.valid)
    return validationFailure(patchValidation, resolved);
  return preparePatchedValue(
    resolved,
    anchor,
    relativeSegments,
    value,
    getLayerValue,
  );
}

async function preparePatchedValue(
  resolved: ResolvedWriteAnchor,
  anchor: CanonicalConfigPath,
  segments: readonly string[],
  value: unknown,
  getLayerValue: (key: string) => Promise<unknown>,
): Promise<SchemaWritePreparation> {
  const baseValue = await getLayerValue(anchor.storageKey);
  const baseValidation = validateExistingLayerValue(baseValue, resolved);
  if (!baseValidation.success) return baseValidation;
  const nextValue = baseValue === undefined ? {} : structuredClone(baseValue);
  setNestedValue(nextValue, segments, value);
  const validation = validatePartialConfiguration(
    resolved.anchor.schema,
    nextValue,
    { path: anchor.segments },
  );
  if (!validation.valid) return validationFailure(validation, resolved);
  return preparedWrite(resolved.anchor, nextValue);
}

function validatePatchTarget(
  resolved: ResolvedWriteAnchor,
  segments: readonly string[],
): FailedSchemaWrite | null {
  if (segments.length > 0) return null;
  return writeFailure("Patches must target a path below a registered anchor", {
    path: resolved.path,
    anchorPath: resolved.anchor.path,
    environment: resolved.environment,
  });
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
    normalized.value.path,
    environment,
  );
  if (anchor === null || anchor.path !== normalized.value.path) {
    return invalidPathValidation(
      `No registered schema anchor for path "${normalized.value.path}" in environment "${environment}"`,
      normalized.value.segments,
    );
  }
  const value = await getEffectiveValue(normalized.value.storageKey);
  return validateEffectiveConfiguration(anchor.schema, value, {
    path: normalized.value.segments,
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
    normalized.value.path,
    environment,
  );
  if (anchor === null) {
    return writeFailure(
      `No registered schema anchor for path "${normalized.value.path}" in environment "${environment}"`,
      { path: normalized.value.path, environment },
    );
  }
  return {
    success: true,
    anchor,
    environment,
    path: normalized.value.path,
    segments: normalized.value.segments,
  };
}

function validateExistingLayerValue(
  value: unknown,
  resolved: ResolvedWriteAnchor,
): SchemaWritePreparation {
  if (value === undefined) return preparedWrite(resolved.anchor, value);
  const validation = validatePartialConfiguration(
    resolved.anchor.schema,
    value,
    { path: parseCanonicalConfigPath(resolved.anchor.path).segments },
  );
  return validation.valid
    ? preparedWrite(resolved.anchor, value)
    : validationFailure(validation, resolved);
}

function validationFailure(
  validation: SchemaValidationResult,
  resolved: ResolvedWriteAnchor,
): FailedSchemaWrite {
  return writeFailure("Configuration does not match registered schema", {
    path: resolved.path,
    anchorPath: resolved.anchor.path,
    environment: resolved.environment,
    errors: validation.errors,
  });
}

function preparedWrite(
  anchor: RegisteredSchemaAnchor,
  value: unknown,
): PreparedSchemaWrite {
  return {
    success: true,
    key: parseCanonicalConfigPath(anchor.path).storageKey,
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

type NormalizedPath =
  | { readonly success: true; readonly value: CanonicalConfigPath }
  | { readonly success: false; readonly message: string };

function normalizeCanonicalPath(path: string): NormalizedPath {
  try {
    const value = parseCanonicalConfigPath(assertPublicConfigPath(path));
    return value.segments.length === 0
      ? { success: false, message: "Configuration writes must not target root" }
      : { success: true, value };
  } catch (error: unknown) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function setNestedValue(
  current: unknown,
  segments: readonly string[],
  value: unknown,
): void {
  const [segment, ...remaining] = segments;
  if (segment === undefined) return;
  if (remaining.length === 0) {
    assignMember(current, segment, value);
    return;
  }
  const existing = readMember(current, segment);
  const next =
    isRecord(existing) || Array.isArray(existing)
      ? existing
      : isArrayIndex(remaining[0])
        ? []
        : {};
  if (next !== existing) assignMember(current, segment, next);
  setNestedValue(next, remaining, value);
}

function readMember(current: unknown, segment: string): unknown {
  if (Array.isArray(current) && isArrayIndex(segment))
    return current[Number(segment)];
  return isRecord(current) && Object.hasOwn(current, segment)
    ? current[segment]
    : undefined;
}

function assignMember(current: unknown, segment: string, value: unknown): void {
  if (Array.isArray(current) && isArrayIndex(segment)) {
    current[Number(segment)] = value;
  } else if (isRecord(current)) {
    current[segment] = value;
  }
}

function invalidPathValidation(
  message: string,
  segments: readonly SchemaValidationPathSegment[] = [],
): SchemaValidationResult {
  return {
    valid: false,
    errors: [
      {
        code: "invalid-path",
        message,
        segments: [...segments],
        path: segments.reduce<string>(
          (current, segment) => `${current}.${String(segment)}`,
          "$",
        ),
      },
    ],
  };
}

function isArrayIndex(segment: string | undefined): boolean {
  if (segment === undefined) return false;
  const index = Number(segment);
  return Number.isInteger(index) && index >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
