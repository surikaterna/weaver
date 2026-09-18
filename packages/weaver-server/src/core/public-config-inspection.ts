import { deepGet, deepMerge } from "@weaver-conf/config-engine";
import type {
  ConfigDelta,
  ConfigurationInspection,
} from "@weaver-conf/config-types";
import {
  filterProtectedConfigEntries,
  filterProtectedConfigScopes,
  isProtectedConfigPath,
} from "./protected-config-paths";

export interface ConfigInspectionLayer {
  readonly layer: string;
  readonly entries: Record<string, unknown>;
}

export const publicConfigView = {
  entries: filterProtectedConfigEntries,
  scopes: filterProtectedConfigScopes,
  resolveScopes: resolvePublicConfigScopes,
  includesDelta(delta: ConfigDelta): boolean {
    return !isProtectedConfigPath(delta.key);
  },
  inspect: inspectPublicConfig,
};

type ResolveEntries = (
  entries: Record<string, unknown>,
  state: Record<string, unknown>,
) => Record<string, unknown>;

function resolvePublicConfigScopes(
  scopes: Record<string, Record<string, unknown>>,
  baseEntries: Record<string, unknown>,
  resolveEntries: ResolveEntries,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(filterProtectedConfigScopes(scopes)).map(
      ([scope, entries]) => [
        scope,
        resolveEntries(entries, deepMerge(baseEntries, entries)),
      ],
    ),
  );
}

export function inspectPublicConfig(
  key: string,
  layers: readonly ConfigInspectionLayer[],
): ConfigurationInspection<unknown> {
  if (isProtectedConfigPath(key)) return emptyInspection(key);

  const layerValues: Record<string, unknown> = {};
  let effectiveValue: unknown;
  let effectiveLayer: string | undefined;
  for (const layer of layers) {
    const entries = publicConfigView.entries(layer.entries);
    const value = deepGet(entries, key);
    if (value === undefined) continue;
    layerValues[layer.layer] = value;
    effectiveValue = value;
    effectiveLayer = layer.layer;
  }
  return { key, effectiveValue, effectiveLayer, layerValues };
}

function emptyInspection(key: string): ConfigurationInspection<unknown> {
  return {
    key,
    effectiveValue: undefined,
    effectiveLayer: undefined,
    layerValues: {},
  };
}
