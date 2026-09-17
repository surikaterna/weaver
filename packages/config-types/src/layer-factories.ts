import { createWeaverError } from "./errors";
import type {
  DynamicLayerConfig,
  EphemeralLayerConfig,
  LayerData,
  LayerDefinition,
  LayerResolver,
  LayerType,
  PersonalLayerConfig,
  ResolutionContext,
  StaticLayerConfig,
} from "./layers";
import type { MergeFunction } from "./merge-types";
import type { ConfigurationStorageProvider } from "./providers";
import { scopeDefinitionSchema } from "./schemas-layers";

// --- Default merge: deep merge ---
// The real deepMerge lives in config-engine, but we need a default reference.
// This is a simple recursive deep merge: null clears, objects merge, arrays replace.
const defaultMerge: MergeFunction = (
  base: unknown,
  override: unknown,
): unknown => {
  if (override === null) return undefined;
  if (override === undefined) return base;
  if (
    typeof base === "object" &&
    base !== null &&
    typeof override === "object" &&
    override !== null &&
    !Array.isArray(base) &&
    !Array.isArray(override)
  ) {
    const result = new Map(Object.entries(base));
    for (const [k, v] of Object.entries(override))
      result.set(k, defaultMerge(result.get(k), v));
    return Object.fromEntries(result);
  }
  return override;
};

/** Replace-only merge: no deep merging, later layer wins completely */
export const replaceOnly: MergeFunction = (
  _base: unknown,
  override: unknown,
): unknown => override;

// --- Built-in LayerType implementations ---

const staticType: LayerType = {
  id: "static",
  persistent: true,
  defaultMerge,
  createResolver(
    provider: ConfigurationStorageProvider,
    _config: unknown,
  ): LayerResolver {
    return {
      resolve: async () => [await providerLayer(provider, provider.layer)],
    };
  },
};

const dynamicType: LayerType = {
  id: "dynamic",
  persistent: true,
  defaultMerge,
  createResolver(
    provider: ConfigurationStorageProvider,
    config: unknown,
  ): LayerResolver {
    return {
      resolve: (context) => dynamicLayers(provider, config, context),
    };
  },
};

const personalType: LayerType = {
  id: "personal",
  persistent: true,
  defaultMerge,
  createResolver(
    _provider: ConfigurationStorageProvider,
    _config: unknown,
  ): LayerResolver {
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Personal layer resolution is not installed",
    );
  },
};

const ephemeralType: LayerType = {
  id: "ephemeral",
  persistent: false,
  defaultMerge,
  createResolver(
    provider: ConfigurationStorageProvider,
    _config: unknown,
  ): LayerResolver {
    return {
      resolve: async () => [await providerLayer(provider, provider.layer)],
    };
  },
};

// --- Factory functions ---
async function providerLayer(
  provider: ConfigurationStorageProvider,
  layer: string,
): Promise<LayerData> {
  if (layer !== provider.layer && !provider.loadLayer)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Provider does not support scoped IO",
    );
  const value =
    layer === provider.layer
      ? await provider.load()
      : await provider.loadLayer?.(layer);
  if (!value)
    throw createWeaverError("PROVIDER_LOAD_FAILED", "Missing layer snapshot");
  return {
    layerId: layer,
    data: structuredClone(value.entries),
    ...(value.revision ? { revision: value.revision } : {}),
  };
}
async function dynamicLayers(
  provider: ConfigurationStorageProvider,
  config: unknown,
  context: ResolutionContext,
): Promise<LayerData[]> {
  const scopes =
    config !== null && typeof config === "object" && "scopes" in config
      ? scopeDefinitionSchema.array().parse(config.scopes)
      : [{ id: provider.layer, label: provider.layer }];
  const layers = scopes.flatMap((scope) => {
    const value =
      context.scopeInstances?.get(scope.id) ??
      (context.scopeId === scope.id ? context.scopeValue : undefined);
    return value === undefined ? [] : [`${scope.id}:${value}`];
  });
  if (!layers.length) return [];
  return Promise.all(
    [provider.layer, ...layers].map((layer) => providerLayer(provider, layer)),
  );
}

/** Creates a static layer definition (persistent, non-scoped). */
function Static<N extends string>(
  name: N,
  config?: StaticLayerConfig,
): LayerDefinition<N> {
  return { name, type: staticType, config: config ?? {} };
}

/** Creates a dynamic layer definition (persistent, scope-aware). */
function Dynamic<N extends string>(
  name: N,
  config?: DynamicLayerConfig,
): LayerDefinition<N> {
  return { name, type: dynamicType, config: config ?? {} };
}

/** Creates a personal layer definition (persistent, per-user). */
function Personal<N extends string>(
  name: N,
  config?: PersonalLayerConfig,
): LayerDefinition<N> {
  return { name, type: personalType, config: config ?? {} };
}

/** Creates an ephemeral layer definition (non-persistent, in-memory only). */
function Ephemeral<N extends string>(
  name: N,
  config?: EphemeralLayerConfig,
): LayerDefinition<N> {
  return { name, type: ephemeralType, config: config ?? {} };
}

/** Built-in layer factories */
export const Layers = {
  Static,
  Dynamic,
  Personal,
  Ephemeral,
} as const;
