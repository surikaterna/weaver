import { deepGet, deepMerge } from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  ScopeInstance,
  WriteResult,
} from "@weaver-conf/config-types";
import {
  isSameScopeLayer,
  isScopedLayer,
  normalizeScopeLayer,
  parseScopeLayer,
} from "./scope-utils";

export interface ScopedLayerProvider {
  loadLayer(layer: string): Promise<{ entries: Record<string, unknown> }>;
  writeLayer(layer: string, key: string, value: unknown): Promise<WriteResult>;
  removeLayer(layer: string, key: string): Promise<WriteResult>;
}

export function hasScopedLayerIo(
  provider: ConfigurationStorageProvider,
): provider is ConfigurationStorageProvider & ScopedLayerProvider {
  return (
    "loadLayer" in provider &&
    typeof provider.loadLayer === "function" &&
    "writeLayer" in provider &&
    typeof provider.writeLayer === "function" &&
    "removeLayer" in provider &&
    typeof provider.removeLayer === "function"
  );
}

export function computeConfigRevision(state: Record<string, unknown>): string {
  const content = JSON.stringify(state);
  let hash = 0;
  for (let index = 0; index < content.length; index++) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0;
  }
  return `rev-${(hash >>> 0).toString(36)}-${Date.now().toString(36)}`;
}

interface ConfigStateOptions {
  readonly providers: ReadonlyArray<ConfigurationStorageProvider>;
  readonly layerData: ReadonlyMap<string, Record<string, unknown>>;
  readonly dynamicScopeEntries: Map<string, Record<string, unknown>>;
  readonly resolveProvider: (
    layer: string,
  ) => ConfigurationStorageProvider | undefined;
  readonly hasScopedLayerIo: (
    provider: ConfigurationStorageProvider,
  ) => provider is ConfigurationStorageProvider & {
    loadLayer(layer: string): Promise<{ entries: Record<string, unknown> }>;
  };
}

export function createConfigServiceState(options: ConfigStateOptions) {
  return {
    getAllScopes: () => allScopes(options),
    getBaseEntries: () => baseEntries(options),
    getLayerEntries: (
      provider: ConfigurationStorageProvider,
      layer: string,
      dynamic: boolean,
    ) => layerEntries(options, provider, layer, dynamic),
    getLayerValue: (layer: string, key: string) =>
      layerValue(options, layer, key),
    getMergedState: (scopePath?: ScopeInstance[]) =>
      mergedState(options, scopePath),
    getScopeState: (scopePath: ScopeInstance[]) =>
      scopeState(options, scopePath),
  };
}

function baseEntries(options: ConfigStateOptions): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const provider of options.providers) {
    if (isScopedLayer(provider.layer)) continue;
    merged = deepMerge(merged, options.layerData.get(provider.id) ?? {});
  }
  return merged;
}

function scopeState(
  options: ConfigStateOptions,
  scopePath: ScopeInstance[],
): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const scope of scopePath) {
    const layer = `${scope.scopeId}:${scope.value}`;
    for (const provider of options.providers) {
      if (provider.layer === layer || isSameScopeLayer(provider.layer, layer)) {
        merged = deepMerge(merged, options.layerData.get(provider.id) ?? {});
      }
    }
    merged = deepMerge(merged, options.dynamicScopeEntries.get(layer) ?? {});
  }
  return merged;
}

function allScopes(
  options: ConfigStateOptions,
): Record<string, Record<string, unknown>> {
  const scopes: Record<string, Record<string, unknown>> = {};
  for (const provider of options.providers) {
    if (!isScopedLayer(provider.layer)) continue;
    scopes[provider.layer] = {
      ...(scopes[provider.layer] ?? {}),
      ...(options.layerData.get(provider.id) ?? {}),
    };
  }
  for (const [layer, entries] of options.dynamicScopeEntries) {
    if (!isScopedLayer(layer)) continue;
    const normalized = normalizeScopeLayer(layer);
    scopes[normalized] = { ...(scopes[normalized] ?? {}), ...entries };
  }
  return scopes;
}

function mergedState(
  options: ConfigStateOptions,
  scopePath?: ScopeInstance[],
): Record<string, unknown> {
  const base = baseEntries(options);
  return scopePath?.length
    ? deepMerge(base, scopeState(options, scopePath))
    : base;
}

function layerEntries(
  options: ConfigStateOptions,
  provider: ConfigurationStorageProvider,
  canonicalLayer: string,
  dynamic: boolean,
): Record<string, unknown> {
  return dynamic
    ? (options.dynamicScopeEntries.get(canonicalLayer) ?? {})
    : (options.layerData.get(provider.id) ?? {});
}

async function layerValue(
  options: ConfigStateOptions,
  layer: string,
  key: string,
): Promise<unknown> {
  const provider = options.resolveProvider(layer);
  if (!provider) return undefined;
  const parsed = parseScopeLayer(layer);
  const dynamic = parsed !== null && provider.layer === parsed.scopeId;
  const canonical = normalizeScopeLayer(layer);
  if (
    dynamic &&
    options.hasScopedLayerIo(provider) &&
    !options.dynamicScopeEntries.has(canonical)
  ) {
    const data = await provider.loadLayer(canonical);
    options.dynamicScopeEntries.set(canonical, data.entries);
  }
  const entries = dynamic
    ? options.dynamicScopeEntries.get(canonical)
    : options.layerData.get(provider.id);
  return deepGet(entries ?? {}, key);
}

interface EffectiveWriteStateOptions {
  readonly providers: ReadonlyArray<ConfigurationStorageProvider>;
  readonly layerData: ReadonlyMap<string, Record<string, unknown>>;
  readonly provider: ConfigurationStorageProvider;
  readonly canonicalLayer: string;
  readonly candidate: Record<string, unknown>;
  readonly scopePath?: ScopeInstance[];
  readonly getScopeState: (
    scopePath: ScopeInstance[],
  ) => Record<string, unknown>;
}

export function effectiveWriteState(
  options: EffectiveWriteStateOptions,
): Record<string, unknown> {
  let merged = mergeBaseLayers(options);
  const parsed = parseScopeLayer(options.canonicalLayer);
  const scopes =
    options.scopePath ??
    (parsed ? [{ scopeId: parsed.scopeId, value: parsed.value }] : []);
  for (const scope of scopes) {
    const layer = `${scope.scopeId}:${scope.value}`;
    const entries =
      layer === options.canonicalLayer
        ? options.candidate
        : options.getScopeState([scope]);
    merged = deepMerge(merged, entries);
  }
  return merged;
}

function mergeBaseLayers(
  options: EffectiveWriteStateOptions,
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  for (const current of options.providers) {
    if (isScopedLayer(current.layer)) continue;
    const replace =
      current === options.provider &&
      options.canonicalLayer === options.provider.layer;
    const entries = replace
      ? options.candidate
      : (options.layerData.get(current.id) ?? {});
    base = deepMerge(base, entries);
  }
  return base;
}
