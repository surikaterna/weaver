import type {
  CanonicalConfigPath,
  SchemaValidationResult,
} from "@weaver-conf/config-engine";
import {
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
  invalidPathValidation,
  normalizeCanonicalPath,
  patchFailure,
  validationFailure,
  writeFailure,
} from "./config-service-schema-errors";
import { buildSchemaPatch } from "./config-service-schema-patches";
import type {
  EffectiveValidationContext,
  SchemaWriteContext,
  WeaverConfigService,
} from "./config-service-types";
import { snapshotSubmitted } from "./config-write-snapshot";
import { protectedConfigMutationError } from "./protected-config-paths";
import type { RegisteredSchemaAnchor, SchemaRegistry } from "./schema-registry";

export interface PreparedSchemaWrite {
  readonly success: true;
  readonly key: string;
  readonly value: unknown;
}

export type SchemaWritePreparation = PreparedSchemaWrite | FailedSchemaWrite;

export interface FailedSchemaWrite {
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
  readonly setPrepared: (
    layer: string,
    key: string,
    value: unknown,
    targetKey: string,
    targetValue: unknown,
    context: SchemaWriteContext,
  ) => Promise<WriteResult>;
  readonly getRegistry: () => SchemaRegistry | undefined;
  readonly serialize: <T>(task: () => Promise<T>) => Promise<T>;
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
    setRegisteredObject: (layer, path, value, context) =>
      performRegisteredWrite(
        options,
        layer,
        path,
        value,
        context,
        (verified, input) =>
          prepareRegisteredObjectWrite(
            path,
            input,
            verified,
            options.defaultEnvironment,
          ),
      ),
    patchRegisteredPath: (layer, path, value, context) =>
      performRegisteredWrite(
        options,
        layer,
        path,
        value,
        context,
        (verified, input) =>
          prepareRegisteredPatchWrite(
            path,
            input,
            verified,
            options.defaultEnvironment,
            (key) => options.getLayerValue(layer, key),
          ),
      ),
    validateRegisteredEffective: (path, context) =>
      validateBoundEffective(options, path, context),
  };
}

function validateBoundEffective(
  options: RegisteredWriteOperationsOptions,
  path: string,
  context: EffectiveValidationContext,
): Promise<SchemaValidationResult> {
  const registry = options.getRegistry();
  if (!registry)
    return Promise.resolve(
      invalidPathValidation("Schema registry is unavailable"),
    );
  const getOptions = context.scopePath
    ? { scopePath: context.scopePath }
    : undefined;
  return validateRegisteredEffectiveConfiguration(
    path,
    {
      ...context,
      schemaRegistry: registry,
      environment: context.environment ?? options.defaultEnvironment,
    },
    options.defaultEnvironment,
    (key) => options.get(key, getOptions),
  );
}

async function performRegisteredWrite(
  options: RegisteredWriteOperationsOptions,
  layer: string,
  path: string,
  value: unknown,
  context: SchemaWriteContext,
  prepare: (
    verified: SchemaWriteContext,
    input: unknown,
  ) => Promise<SchemaWritePreparation>,
): Promise<WriteResult> {
  const protectedError = protectedConfigMutationError(path);
  if (protectedError) return protectedError;
  const snapshot = snapshotSubmitted(value);
  if (!snapshot.success) return snapshot.result;
  return options.serialize(async () => {
    const failure = registeredWritePreflight(options, path, context);
    if (failure) return failure;
    const registry = options.getRegistry();
    if (!registry) return registryUnavailable();
    const verified = {
      ...context,
      schemaRegistry: registry,
      environment: context.environment ?? options.defaultEnvironment,
    };
    const prepared = await prepare(verified, snapshot.value);
    if (!prepared.success) return prepared.result;
    return options.setPrepared(
      layer,
      prepared.key,
      prepared.value,
      parseCanonicalConfigPath(path).storageKey,
      snapshot.value,
      verified,
    );
  });
}

function registryUnavailable(): WriteResult {
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Schema registry is not bound to the config service",
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

export interface ResolvedWriteAnchor {
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
    return {
      success: false,
      result: {
        success: false,
        error: {
          code: "SCHEMA_NOT_REGISTERED",
          message: `No registered schema anchor for path "${normalized.value.path}" in environment "${environment}"`,
          details: { path: normalized.value.path, environment },
        },
      },
    };
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
