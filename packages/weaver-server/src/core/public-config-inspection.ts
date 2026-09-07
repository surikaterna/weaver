import { deepGet } from "@weaver-conf/config-engine";
import type { ConfigurationInspection } from "@weaver-conf/config-types";
import {
  filterProtectedConfigEntries,
  isProtectedConfigPath,
} from "./protected-config-paths";

export interface ConfigInspectionLayer {
  readonly layer: string;
  readonly entries: Record<string, unknown>;
}

export function inspectPublicConfig(
  key: string,
  layers: readonly ConfigInspectionLayer[],
): ConfigurationInspection<unknown> {
  if (isProtectedConfigPath(key)) {
    return {
      key,
      effectiveValue: undefined,
      effectiveLayer: undefined,
      layerValues: {},
    };
  }

  const layerValues: Record<string, unknown> = {};
  let effectiveValue: unknown;
  let effectiveLayer: string | undefined;
  for (const layer of layers) {
    const entries = filterProtectedConfigEntries(layer.entries);
    const value = deepGet(entries, key);
    if (value === undefined) continue;
    layerValues[layer.layer] = value;
    effectiveValue = value;
    effectiveLayer = layer.layer;
  }
  return { key, effectiveValue, effectiveLayer, layerValues };
}
