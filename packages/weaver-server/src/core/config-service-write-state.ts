import { deepGet } from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import { normalizeScopeLayer, parseScopeLayer } from "./scope-utils";

export interface ScopedLayerProvider {
  loadLayer(layer: string): Promise<{ entries: Record<string, unknown> }>;
  writeLayer(layer: string, key: string, value: unknown): Promise<WriteResult>;
  removeLayer(layer: string, key: string): Promise<WriteResult>;
}

export function hasScopedLayerIo(
  provider: ConfigurationStorageProvider,
): provider is ConfigurationStorageProvider & ScopedLayerProvider {
  return (
    typeof provider.loadLayer === "function" &&
    typeof provider.writeLayer === "function" &&
    typeof provider.removeLayer === "function"
  );
}

interface ConfigStateOptions {
  readonly layerData: ReadonlyMap<string, Record<string, unknown>>;
  readonly dynamicScopeEntries: ReadonlyMap<string, Record<string, unknown>>;
  readonly resolveProvider: (
    layer: string,
  ) => ConfigurationStorageProvider | undefined;
}

/** Raw layer access only. Layout merging and effective evaluation belong to the pipeline. */
export function createConfigServiceState(options: ConfigStateOptions) {
  const layerEntries = (
    provider: ConfigurationStorageProvider,
    layer: string,
    dynamic: boolean,
  ) =>
    (dynamic
      ? options.dynamicScopeEntries.get(layer)
      : options.layerData.get(provider.id)) ?? {};
  return {
    getLayerEntries: layerEntries,
    async getLayerValue(layer: string, key: string): Promise<unknown> {
      const provider = options.resolveProvider(layer);
      if (!provider) return undefined;
      const parsed = parseScopeLayer(layer);
      const dynamic = parsed !== null && provider.layer === parsed.scopeId;
      return deepGet(
        layerEntries(provider, normalizeScopeLayer(layer), dynamic),
        key,
      );
    },
  };
}
