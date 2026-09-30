import { deepMerge } from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  ScopeInstance,
} from "@weaver-conf/config-types";
import { hasScopedLayerIo } from "./config-service-internal";
import {
  isSameScopeLayer,
  isScopedLayer,
  normalizeScopeLayer,
} from "./scope-utils";

interface StateContext {
  readonly providers: readonly ConfigurationStorageProvider[];
  readonly layerData: ReadonlyMap<string, Record<string, unknown>>;
  readonly dynamicScopeEntries: Map<string, Record<string, unknown>>;
}

async function warmScopeLayers(
  state: StateContext,
  scopePath?: ScopeInstance[],
): Promise<void> {
  if (!scopePath?.length) return;
  for (const scope of scopePath) {
    const layer = `${scope.scopeId}:${scope.value}`;
    for (const provider of state.providers) {
      if (!hasScopedLayerIo(provider) || provider.layer !== scope.scopeId)
        continue;
      if (state.dynamicScopeEntries.has(layer)) continue;
      const data = await provider.loadLayer(layer);
      state.dynamicScopeEntries.set(layer, data.entries);
    }
  }
}

function baseEntries(state: StateContext): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const provider of state.providers) {
    if (isScopedLayer(provider.layer)) continue;
    merged = deepMerge(merged, state.layerData.get(provider.id) ?? {});
  }
  return merged;
}

function scopeState(
  state: StateContext,
  scopePath: ScopeInstance[],
): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const scope of scopePath) {
    const scopedLayer = `${scope.scopeId}:${scope.value}`;
    for (const provider of state.providers) {
      if (!isSameScopeLayer(provider.layer, scopedLayer)) continue;
      merged = deepMerge(merged, state.layerData.get(provider.id) ?? {});
    }
    const dynamic = state.dynamicScopeEntries.get(scopedLayer);
    if (dynamic) merged = deepMerge(merged, dynamic);
  }
  return merged;
}

function allScopes(
  state: StateContext,
): Record<string, Record<string, unknown>> {
  const scopes: Record<string, Record<string, unknown>> = {};
  for (const provider of state.providers) {
    if (!isScopedLayer(provider.layer)) continue;
    const entries = state.layerData.get(provider.id) ?? {};
    scopes[provider.layer] = { ...(scopes[provider.layer] ?? {}), ...entries };
  }
  for (const [layer, entries] of state.dynamicScopeEntries) {
    if (!isScopedLayer(layer)) continue;
    const normalized = normalizeScopeLayer(layer);
    scopes[normalized] = { ...(scopes[normalized] ?? {}), ...entries };
  }
  return scopes;
}

export function createConfigStateReader(
  providers: readonly ConfigurationStorageProvider[],
  layerData: ReadonlyMap<string, Record<string, unknown>>,
  dynamicScopeEntries: Map<string, Record<string, unknown>>,
) {
  const state = { providers, layerData, dynamicScopeEntries };
  return {
    getBaseEntries: () => baseEntries(state),
    getScopeState: (path: ScopeInstance[]) => scopeState(state, path),
    getAllScopes: () => allScopes(state),
    getMergedState: (path?: ScopeInstance[]) => {
      const base = baseEntries(state);
      return path?.length ? deepMerge(base, scopeState(state, path)) : base;
    },
    getRevisionState: () => ({
      base: baseEntries(state),
      scopes: allScopes(state),
    }),
    warmScopeLayers: (path?: ScopeInstance[]) => warmScopeLayers(state, path),
  };
}

export function computeRevision(state: Record<string, unknown>): string {
  const content = JSON.stringify(state);
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return `rev-${(hash >>> 0).toString(36)}-${Date.now().toString(36)}`;
}
