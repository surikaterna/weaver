import {
  canonicalConfigPathFromStorageKey,
  deepGet,
  deepRemove,
  deepSet,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";
import type { WeaverConfigService } from "./config-service-types";
import { protectedConfigMutationError } from "./protected-config-paths";
import type { RegisteredSchemaAnchor, SchemaRegistry } from "./schema-registry";

interface SchemaBoundaryBinding {
  readonly registry: SchemaRegistry;
  readonly affectedAnchors: (
    path: string,
    environment: string,
  ) => ReadonlyArray<RegisteredSchemaAnchor>;
}

interface ValidationState {
  readonly layerEntries: Record<string, unknown>;
  readonly effectiveEntries?: Record<string, unknown>;
}

export type NormalizedBatchEntries =
  | { readonly success: true; readonly entries: Record<string, unknown> }
  | { readonly success: false; readonly result: WriteResult };

const bindings = new WeakMap<
  WeaverConfigService,
  ReadonlyArray<SchemaBoundaryBinding>
>();
const defaultEnvironments = new WeakMap<WeaverConfigService, string>();

export function registerSchemaBoundaryHost(
  service: WeaverConfigService,
  defaultEnvironment: string,
): void {
  defaultEnvironments.set(service, defaultEnvironment);
}

export function bindSchemaRegistry(
  service: WeaverConfigService,
  registry: SchemaRegistry,
  affectedAnchors: SchemaBoundaryBinding["affectedAnchors"],
): void {
  const current = bindings.get(service) ?? [];
  if (current.some((binding) => binding.registry === registry)) return;
  bindings.set(service, [...current, { registry, affectedAnchors }]);
}

export function validatePublicWrite(key: string): WriteResult | null {
  return protectedConfigMutationError(key);
}

export function normalizeBatchEntries(
  entries: Record<string, unknown>,
): NormalizedBatchEntries {
  const normalized: Record<string, unknown> = {};
  const sourceByKey = new Map<string, string>();
  for (const [source, value] of Object.entries(entries)) {
    const key = canonicalStorageKey(source);
    if (key === null)
      return failedBatch("Invalid configuration path", { key: source });
    const previous = sourceByKey.get(key);
    if (previous !== undefined) {
      return failedBatch("Batch contains duplicate configuration paths", {
        canonicalKey: key,
        paths: [previous, source],
      });
    }
    sourceByKey.set(key, source);
    normalized[key] = value;
  }
  return { success: true, entries: normalized };
}

export function validateBoundSet(
  service: WeaverConfigService,
  key: string,
  value: unknown,
  state: ValidationState,
): WriteResult | null {
  const candidate = structuredClone(state.layerEntries);
  deepSet(candidate, key, value);
  return validateAffected(service, key, candidate, false);
}

export function validateBoundSetMany(
  service: WeaverConfigService,
  entries: Record<string, unknown>,
  layerEntries: Record<string, unknown>,
): WriteResult | null {
  const candidate = structuredClone(layerEntries);
  for (const [key, value] of Object.entries(entries))
    deepSet(candidate, key, value);
  for (const key of Object.keys(entries)) {
    const failure = validateAffected(service, key, candidate, false);
    if (failure) return failure;
  }
  return null;
}

export function validateBoundRemove(
  service: WeaverConfigService,
  key: string,
  state: ValidationState,
): WriteResult | null {
  const candidateLayer = structuredClone(state.layerEntries);
  deepRemove(candidateLayer, key);
  const effective = state.effectiveEntries ?? candidateLayer;
  return validateAffected(service, key, effective, true);
}

function validateAffected(
  service: WeaverConfigService,
  key: string,
  entries: Record<string, unknown>,
  effective: boolean,
): WriteResult | null {
  const serviceBindings = bindings.get(service);
  if (!serviceBindings) return null;
  const environment = defaultEnvironments.get(service) ?? "";
  const path = storagePath(key);
  if (path === null)
    return validationFailure("Invalid configuration path", { key });

  const anchors = serviceBindings.flatMap((binding) =>
    binding.affectedAnchors(path, environment),
  );
  for (const anchor of anchors) {
    const anchorKey = parseCanonicalConfigPath(anchor.path).storageKey;
    const value = deepGet(entries, anchorKey);
    if (!effective && value === undefined) continue;
    const validation = effective
      ? validateEffectiveConfiguration(anchor.schema, value, {
          path: parseCanonicalConfigPath(anchor.path).segments,
        })
      : validatePartialConfiguration(anchor.schema, value, {
          path: parseCanonicalConfigPath(anchor.path).segments,
        });
    if (!validation.valid) {
      return validationFailure(
        "Configuration does not match registered schema",
        {
          path,
          anchorPath: anchor.path,
          environment,
          errors: validation.errors,
        },
      );
    }
  }
  return null;
}

function storagePath(key: string): string | null {
  try {
    return canonicalConfigPathFromStorageKey(key).path;
  } catch {
    return null;
  }
}

function canonicalStorageKey(key: string): string | null {
  try {
    return canonicalConfigPathFromStorageKey(key).storageKey;
  } catch {
    return null;
  }
}

function failedBatch(
  message: string,
  details: Record<string, unknown>,
): NormalizedBatchEntries {
  return { success: false, result: validationFailure(message, details) };
}

function validationFailure(
  message: string,
  details: Record<string, unknown>,
): WriteResult {
  return {
    success: false,
    error: { code: "VALIDATION_ERROR", message, details },
  };
}
