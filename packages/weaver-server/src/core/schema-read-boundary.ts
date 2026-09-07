import {
  canonicalConfigPathFromStorageKey,
  deepGet,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
} from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import { WeaverErrorInstance } from "@weaver-conf/config-types";
import { createWeaverError } from "../types/errors";
import type { ConfigDelta } from "../types/index";
import type { WeaverConfigService } from "./config-service-types";
import type { RegisteredSchemaAnchor } from "./schema-registry";
import { parseScopeLayer, parseScopeQuery } from "./scope-utils";

type AnchorEnumerator = (
  environment: string,
) => ReadonlyArray<RegisteredSchemaAnchor>;

interface SchemaReadBinding {
  readonly anchors: AnchorEnumerator;
}

const bindings = new WeakMap<
  WeaverConfigService,
  ReadonlyArray<SchemaReadBinding>
>();
const environments = new WeakMap<WeaverConfigService, string>();
const suppressedAnchors = new WeakMap<
  WeaverConfigService,
  Map<string, Set<string>>
>();

export function registerSchemaReadHost(
  service: WeaverConfigService,
  environment: string,
): void {
  environments.set(service, environment);
}

export function bindSchemaReadRegistry(
  service: WeaverConfigService,
  anchors: AnchorEnumerator,
): void {
  const current = bindings.get(service) ?? [];
  bindings.set(service, [...current, { anchors }]);
}

export function assertValidRuntimeRead(
  service: WeaverConfigService,
  entries: Record<string, unknown>,
  requestedKey?: string,
): void {
  const environment = environments.get(service) ?? "";
  const requestedPath = requestedKey
    ? runtimePathFromStorageKey(requestedKey)
    : undefined;
  const anchors = runtimeAnchors(service, environment, requestedPath);

  for (const anchor of anchors) {
    const parsed = parseCanonicalConfigPath(anchor.path);
    const value = deepGet(entries, parsed.storageKey);
    const validation = validateEffectiveConfiguration(anchor.schema, value, {
      path: parsed.segments,
    });
    if (validation.valid) continue;

    throw createWeaverError(
      "VALIDATION_ERROR",
      "Effective configuration does not match registered schema",
      {
        kind: "effective-configuration-invalid",
        anchorPath: anchor.path,
        environment,
        errors: validation.errors,
      },
    );
  }
}

export function isEffectiveConfigurationError(error: unknown): boolean {
  return (
    error instanceof WeaverErrorInstance &&
    error.details?.kind === "effective-configuration-invalid"
  );
}

export function assertValidRuntimeScopes(
  service: WeaverConfigService,
  scopes: Record<string, Record<string, unknown>>,
  resolve: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
): void {
  for (const scope of Object.keys(scopes).sort()) {
    assertValidRuntimeRead(service, resolve(parseScopeQuery(scope)));
  }
}

export function runtimeDeltasToPublish(
  service: WeaverConfigService,
  delta: ConfigDelta,
  resolve: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
): ConfigDelta[] {
  const scope = parseScopeLayer(delta.layer);
  const scopePath = scope
    ? [{ scopeId: scope.scopeId, value: scope.value }]
    : undefined;
  const entries = resolve(scopePath);
  try {
    assertValidRuntimeRead(service, entries, delta.key);
  } catch (error: unknown) {
    const anchorPath = effectiveErrorAnchor(error);
    if (anchorPath !== undefined)
      rememberSuppressed(service, delta.layer, anchorPath);
    if (isEffectiveConfigurationError(error)) return [];
    throw error;
  }

  return recoverSuppressedDeltas(service, delta, entries);
}

function effectiveErrorAnchor(error: unknown): string | undefined {
  if (!isEffectiveConfigurationError(error)) return undefined;
  const anchorPath =
    error instanceof WeaverErrorInstance
      ? error.details?.anchorPath
      : undefined;
  return typeof anchorPath === "string" ? anchorPath : undefined;
}

function rememberSuppressed(
  service: WeaverConfigService,
  layer: string,
  anchorPath: string,
): void {
  const byLayer = suppressedAnchors.get(service) ?? new Map();
  const anchors = byLayer.get(layer) ?? new Set();
  anchors.add(anchorPath);
  byLayer.set(layer, anchors);
  suppressedAnchors.set(service, byLayer);
}

function recoverSuppressedDeltas(
  service: WeaverConfigService,
  delta: ConfigDelta,
  entries: Record<string, unknown>,
): ConfigDelta[] {
  const anchors = suppressedAnchors.get(service)?.get(delta.layer);
  if (!anchors) return [delta];
  const recovered: ConfigDelta[] = [];
  for (const anchorPath of [...anchors].sort()) {
    const key = parseCanonicalConfigPath(anchorPath).storageKey;
    try {
      assertValidRuntimeRead(service, entries, key);
    } catch (error: unknown) {
      if (isEffectiveConfigurationError(error)) continue;
      throw error;
    }
    anchors.delete(anchorPath);
    recovered.push({
      ...delta,
      action: "set",
      key,
      value: deepGet(entries, key),
    });
  }
  if (anchors.size === 0) suppressedAnchors.get(service)?.delete(delta.layer);
  const deltaPath = runtimePathFromStorageKey(delta.key);
  const replacesDelta = recovered.some((item) => {
    const anchorPath = runtimePathFromStorageKey(item.key);
    return (
      anchorPath !== undefined &&
      deltaPath !== undefined &&
      pathsIntersect(anchorPath, deltaPath)
    );
  });
  return replacesDelta ? recovered : [...recovered, delta];
}

function runtimeAnchors(
  service: WeaverConfigService,
  environment: string,
  requestedPath: string | undefined,
): RegisteredSchemaAnchor[] {
  const registered = bindings.get(service) ?? [];
  return registered
    .flatMap((binding) => binding.anchors(environment))
    .filter(
      (anchor) =>
        requestedPath === undefined ||
        pathsIntersect(anchor.path, requestedPath),
    )
    .sort(compareAnchors);
}

function pathsIntersect(anchorPath: string, requestedPath: string): boolean {
  return (
    anchorPath === requestedPath ||
    anchorPath.startsWith(`${requestedPath}/`) ||
    requestedPath.startsWith(`${anchorPath}/`)
  );
}

function compareAnchors(
  left: RegisteredSchemaAnchor,
  right: RegisteredSchemaAnchor,
): number {
  return (
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
  );
}

function runtimePathFromStorageKey(key: string): string | undefined {
  try {
    return canonicalConfigPathFromStorageKey(key).path;
  } catch {
    return undefined;
  }
}
