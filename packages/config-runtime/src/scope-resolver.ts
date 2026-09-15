import { deepGet, resolveConfiguration } from "@weaver-conf/config-engine";
import type {
  ConfigurationLayerEntry,
  ConfigurationLayerStack,
  LayerDefinition,
  MergeFunction,
  ScopeInstance,
  ScopeResolutionCache,
  WeaverConfig,
} from "@weaver-conf/config-types";
import {
  scopeDefinitionSchema,
  serializeScopePath,
} from "@weaver-conf/config-types";

export interface ScopeResolverOptions {
  /** Retrieve raw entries for a named layer. */
  getLayerEntries: (
    layer: string,
    definition?: LayerDefinition,
  ) => Record<string, unknown>;
  weaverConfig: WeaverConfig;
  cacheSize?: number;
}

export interface ScopeResolver {
  getForScope(key: string, scopePath: ScopeInstance[]): unknown;
  invalidate(): void;
  buildScopedStack(scopePath: ScopeInstance[]): ConfigurationLayerStack;
}

/** Simple LRU cache for scope resolution results. */
export function createScopeCache(maxSize = 100): ScopeResolutionCache {
  const entries = new Map<string, Record<string, unknown>>();
  const order: string[] = [];

  return {
    get(scopeKey: string): Record<string, unknown> | undefined {
      const value = entries.get(scopeKey);
      if (value !== undefined) {
        const idx = order.indexOf(scopeKey);
        if (idx > 0) {
          order.splice(idx, 1);
          order.unshift(scopeKey);
        }
      }
      return value;
    },

    set(scopeKey: string, data: Record<string, unknown>): void {
      if (entries.has(scopeKey)) {
        entries.set(scopeKey, data);
        const idx = order.indexOf(scopeKey);
        if (idx > 0) {
          order.splice(idx, 1);
          order.unshift(scopeKey);
        }
        return;
      }
      // Evict LRU if at capacity
      while (order.length >= maxSize) {
        const evicted = order.pop();
        if (evicted) entries.delete(evicted);
      }
      entries.set(scopeKey, data);
      order.unshift(scopeKey);
    },

    clear(): void {
      entries.clear();
      order.length = 0;
    },
  };
}

export function createScopeResolver(
  options: ScopeResolverOptions,
): ScopeResolver {
  const { cacheSize = 100 } = options;
  const cache = createScopeCache(cacheSize);

  function resolveForScope(
    scopePath: ScopeInstance[],
  ): Record<string, unknown> {
    const cacheKey = serializeScopePath(scopePath);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const stack = buildScopedStack(options, scopePath);
    const merged = resolveConfiguration(stack).entries;

    cache.set(cacheKey, merged);
    return merged;
  }

  return {
    getForScope(key: string, scopePath: ScopeInstance[]): unknown {
      const resolved = resolveForScope(scopePath);
      return deepGet(resolved, key);
    },

    invalidate(): void {
      cache.clear();
    },

    buildScopedStack: (scopePath) => buildScopedStack(options, scopePath),
  };
}

function buildScopedStack(
  options: ScopeResolverOptions,
  scopePath: ScopeInstance[],
): ConfigurationLayerStack {
  const layers: ConfigurationLayerEntry[] = [];
  for (const definition of options.weaverConfig.layers) {
    const merge = layerMerge(definition.config) ?? definition.type.defaultMerge;
    const names =
      definition.type.id === "dynamic" ? dynamicDimensions(definition) : [];
    if (
      !names.every((name) => scopePath.some((scope) => scope.scopeId === name))
    )
      continue;
    layers.push({
      layer: definition.name,
      entries: options.getLayerEntries(definition.name, definition),
      merge,
    });
    for (const scope of scopePath.filter((entry) =>
      names.includes(entry.scopeId),
    )) {
      const physical = `${scope.scopeId}:${scope.value}`;
      layers.push({
        layer: physical,
        entries: options.getLayerEntries(physical, definition),
        merge,
      });
    }
  }
  return { layers };
}

function layerMerge(config: unknown): MergeFunction | undefined {
  if (
    config !== null &&
    typeof config === "object" &&
    "merge" in config &&
    typeof config.merge === "function"
  ) {
    const merge = config.merge;
    return (base, override) => merge(base, override);
  }
  return undefined;
}
function dynamicDimensions(definition: LayerDefinition): string[] {
  const config = definition.config;
  if (
    config !== null &&
    typeof config === "object" &&
    "scopes" in config &&
    config.scopes !== undefined
  )
    return scopeDefinitionSchema
      .array()
      .parse(config.scopes)
      .map((scope) => scope.id);
  return [definition.name];
}
