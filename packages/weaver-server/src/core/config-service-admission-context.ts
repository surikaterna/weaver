import type {
  ConfigurationStorageProvider,
  ScopeInstance,
  WriteResult,
} from "@weaver-conf/config-types";
import {
  boundSchemaRegistry,
  hasScopedLayerIo,
} from "./config-service-internal";
import type { WeaverConfigService, WriteContext } from "./config-service-types";
import { type Mutation, prepareConfigMutation } from "./config-write-admission";
import { resolveOrderedEntries } from "./ordered-config-resolution";
import {
  isSameScopeLayer,
  isScopedLayer,
  normalizeScopeLayer,
  parseScopeLayer,
} from "./scope-utils";

interface AdmissionDependencies {
  readonly service: () => WeaverConfigService;
  readonly environment: string;
  readonly providers: readonly ConfigurationStorageProvider[];
  readonly layerData: ReadonlyMap<string, Record<string, unknown>>;
  readonly dynamicScopeEntries: ReadonlyMap<string, Record<string, unknown>>;
  readonly resolveProvider: (
    layer: string,
  ) => ConfigurationStorageProvider | undefined;
  readonly getLayerValue: (layer: string, key: string) => Promise<unknown>;
  readonly warmScopeLayers: (scopePath?: ScopeInstance[]) => Promise<void>;
}

function projectedState(
  deps: AdmissionDependencies,
  layer: string,
  candidate: Record<string, unknown>,
  scopePath?: ScopeInstance[],
): Record<string, unknown> {
  const scoped = parseScopeLayer(layer);
  const target = deps.resolveProvider(layer);
  const dynamicWrite = scoped !== null && target?.layer === scoped.scopeId;
  const scopes = (scopePath ?? []).filter(
    (scope) =>
      scope.scopeId !== scoped?.scopeId || scope.value !== scoped.value,
  );
  if (scoped) scopes.push(scoped);
  const ordered: Record<string, unknown>[] = [];
  for (const provider of deps.providers) {
    if (isScopedLayer(provider.layer)) continue;
    ordered.push(
      provider === target && !dynamicWrite
        ? candidate
        : (deps.layerData.get(provider.id) ?? {}),
    );
  }
  for (const scope of scopes) {
    const scopedLayer = `${scope.scopeId}:${scope.value}`;
    for (const provider of deps.providers) {
      if (!isSameScopeLayer(provider.layer, scopedLayer)) continue;
      const entries =
        provider === target && !dynamicWrite
          ? candidate
          : (deps.layerData.get(provider.id) ?? {});
      ordered.push(entries);
    }
    const dynamic =
      dynamicWrite && isSameScopeLayer(layer, scopedLayer)
        ? candidate
        : deps.dynamicScopeEntries.get(scopedLayer);
    if (dynamic) ordered.push(dynamic);
  }
  return resolveOrderedEntries(ordered);
}

function layerError(layer: string, message: string): WriteResult {
  return {
    success: false,
    error: { code: "LAYER_NOT_FOUND", message: `${message} "${layer}"` },
  };
}

function scopeUnavailable(): WriteResult {
  return {
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Scoped layer is unavailable" },
  };
}

export function createConfigAdmission(deps: AdmissionDependencies) {
  return async function preflight(
    layer: string,
    mutations: readonly Mutation[],
    opts?: WriteContext,
  ): Promise<WriteResult | null> {
    const provider = deps.resolveProvider(layer);
    if (!provider) return layerError(layer, "No provider for layer");
    const scoped = parseScopeLayer(layer);
    const dynamic = scoped !== null && provider.layer === scoped.scopeId;
    if (dynamic && !hasScopedLayerIo(provider))
      return layerError(layer, "Provider cannot write scoped layer");
    try {
      await deps.warmScopeLayers(opts?.scopePath);
      if (dynamic) await deps.getLayerValue(layer, mutations[0]?.key ?? "");
    } catch {
      return scopeUnavailable();
    }
    const before = dynamic
      ? (deps.dynamicScopeEntries.get(normalizeScopeLayer(layer)) ?? {})
      : (deps.layerData.get(provider.id) ?? {});
    const scopedCandidates = scoped
      ? [opts?.scopePath]
      : opts?.scopePath
        ? [undefined, opts.scopePath]
        : [undefined];
    for (const environment of new Set([
      deps.environment,
      opts?.environment ?? deps.environment,
    ])) {
      for (const path of scopedCandidates) {
        const prepared = prepareConfigMutation({
          registry: boundSchemaRegistry(deps.service()),
          environment,
          mutations,
          layerBefore: before,
          effectiveAfter: (candidate) =>
            projectedState(deps, layer, candidate, path),
        });
        if (!prepared.success) return prepared.result;
      }
    }
    return null;
  };
}
