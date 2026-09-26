import type {
  CanonicalConfigPath,
  SchemaValidationPathSegment,
  SchemaValidationResult,
} from "@weaver-conf/config-engine";
import {
  assertPublicConfigPath,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "@weaver-conf/config-engine";
import {
  type ConfigurationValidationSession,
  createConfigurationValidationSession,
} from "@weaver-conf/config-engine/internal/schema-validation-session";
import type { ScopeInstance, WriteResult } from "@weaver-conf/config-types";
import {
  buildSchemaPatch,
  type SchemaPatchResult,
} from "./config-service-schema-patches";
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
  const session = createConfigurationValidationSession(resolved.anchor.schema, {
    path: anchor.segments,
  });
  const patchValidation = session.validatePatch(relativeSegments, value);
  if (!patchValidation.valid)
    return validationFailure(patchValidation, resolved);
  return preparePatchedValue(
    resolved,
    anchor,
    relativeSegments,
    value,
    session,
    getLayerValue,
  );
}

async function preparePatchedValue(
  resolved: ResolvedWriteAnchor,
  anchor: CanonicalConfigPath,
  segments: readonly string[],
  value: unknown,
  session: ConfigurationValidationSession,
  getLayerValue: (key: string) => Promise<unknown>,
): Promise<SchemaWritePreparation> {
  const baseValue = await getLayerValue(anchor.storageKey);
  const baseValidation = validateExistingLayerValue(
    baseValue,
    resolved,
    session,
  );
  if (!baseValidation.success) return baseValidation;
  const patch = buildSchemaPatch(
    baseValue,
    segments,
    value,
    resolved.anchor.schema,
  );
  if (!patch.success) return patchFailure(patch, resolved);
  const validation = session.validatePartial(patch.value);
  if (!validation.valid) return validationFailure(validation, resolved);
  return preparedWrite(resolved.anchor, patch.value);
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
  session: ConfigurationValidationSession,
): SchemaWritePreparation {
  if (value === undefined) return preparedWrite(resolved.anchor, value);
  const validation = session.validatePartial(value);
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

function patchFailure(
  failure: Exclude<SchemaPatchResult, { readonly success: true }>,
  resolved: ResolvedWriteAnchor,
): FailedSchemaWrite {
  const details = {
    path: resolved.path,
    anchorPath: resolved.anchor.path,
    environment: resolved.environment,
  };
  if (failure.reason === "array-index-out-of-range") {
    return writeFailure(
      `Array patch index ${String(failure.index)} exceeds current length ${String(failure.length)}`,
      { ...details, index: failure.index, length: failure.length },
    );
  }
  return writeFailure("Configuration patch cannot traverse the current value", {
    ...details,
    segment: failure.segment,
  });
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
