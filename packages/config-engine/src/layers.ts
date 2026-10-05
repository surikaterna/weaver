// Layer resolution engine — core configuration resolution logic

import type {
  ConfigurationInspection,
  ConfigurationLayer,
  ConfigurationLayerStack,
} from "@weaver-conf/config-types";

import { deepMerge } from "./merge";

export interface ResolvedConfiguration {
  entries: Record<string, unknown>;
  provenance: Map<string, string>;
}

/**
 * Resolves a configuration layer stack by deep merging all layers in order.
 * First layer = lowest priority, last layer = highest priority.
 * Tracks provenance: for each top-level key, which layer set it last.
 */
export function resolveConfiguration(
  stack: ConfigurationLayerStack,
): ResolvedConfiguration {
  let entries: Record<string, unknown> = {};
  const provenance = new Map<string, string>();

  for (const layerEntry of stack.layers) {
    const layerKeys = Object.keys(layerEntry.entries);
    if (layerKeys.length === 0) {
      continue;
    }

    const mergeFn = layerEntry.merge ?? deepMerge;
    entries = mergeFn(entries, layerEntry.entries) as Record<string, unknown>; // SAFETY: mergeFn returns Record for Record inputs

    for (const key of layerKeys) {
      if (layerEntry.entries[key] !== undefined) {
        provenance.set(key, layerEntry.layer);
      }
    }
  }

  return { entries, provenance };
}

/**
 * Inspects a specific key across all layers in a stack.
 * Keys are FLAT — the dot-delimited key is looked up directly
 * in each layer's entries record.
 */
export function inspectKey<T>(
  stack: ConfigurationLayerStack,
  key: string,
): ConfigurationInspection<T> {
  const inspection: ConfigurationInspection<T> = {
    key,
    effectiveValue: undefined,
    effectiveLayer: undefined,
    layerValues: {},
  };

  for (const layerEntry of stack.layers) {
    if (!(key in layerEntry.entries)) {
      continue;
    }

    const value = layerEntry.entries[key] as T; // SAFETY: caller asserts type via generic parameter
    inspection.effectiveValue = value;
    inspection.effectiveLayer = layerEntry.layer;
    inspection.layerValues[layerEntry.layer] = value;
  }

  return inspection;
}

/**
 * Resolves configuration with ceiling enforcement.
 * For each key, if schemaMap has a maxOverrideLayer, values from layers
 * above the ceiling are ignored — UNLESS isEmergencyOverride is true.
 */
export function resolveConfigurationWithCeiling(
  stack: ConfigurationLayerStack,
  schemaMap: Map<
    string,
    {
      "x-weaver"?:
        | { maxOverrideLayer?: ConfigurationLayer | undefined }
        | undefined;
    }
  >,
  isEmergencyOverride: boolean,
  getRank: (layer: string) => number,
): ResolvedConfiguration {
  if (isEmergencyOverride) {
    return resolveConfiguration(stack);
  }

  // Build a filtered stack: for each layer, remove keys that exceed their ceiling
  const filteredLayers = stack.layers.map((layerEntry) => {
    const layerRank = getRank(layerEntry.layer);
    const filteredEntries: Record<string, unknown> = {};

    for (const key of Object.keys(layerEntry.entries)) {
      const schema = schemaMap.get(key);
      if (schema?.["x-weaver"]?.maxOverrideLayer !== undefined) {
        const ceilingRank = getRank(schema["x-weaver"].maxOverrideLayer);
        if (layerRank > ceilingRank) {
          continue; // Skip: this layer is above the ceiling for this key
        }
      }
      filteredEntries[key] = layerEntry.entries[key];
    }

    return { ...layerEntry, entries: filteredEntries };
  });

  return resolveConfiguration({ layers: filteredLayers });
}
