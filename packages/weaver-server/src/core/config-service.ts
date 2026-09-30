import { consoleLogger, deepGet } from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  ScopeInstance,
  WriteResult,
} from "@weaver-conf/config-types";
import type { ConfigDelta, ConfigSnapshot } from "../types/index";
import { createConfigAdmission } from "./config-service-admission-context";
import { createConfigBatch } from "./config-service-batch";
import { createPublicDeltaEmitter } from "./config-service-deltas";
import {
  boundSchemaRegistry,
  createRegistryAccess,
  hasScopedLayerIo,
  registerInternalConfigAccess,
  serializeConfigMutation,
} from "./config-service-internal";
import { createConfigServiceMutations } from "./config-service-mutations";
import { createRegisteredWriteOperations } from "./config-service-schema-writes";
import {
  computeRevision,
  createConfigStateReader,
} from "./config-service-state";
import type {
  WeaverConfigService,
  WeaverConfigServiceOptions,
  WriteContext,
} from "./config-service-types";
import { isProtectedConfigPath } from "./protected-config-paths";
import { publicConfigView } from "./public-config-inspection";
import { createResolutionPipeline } from "./resolution-pipeline";
import {
  buildScopePathString,
  isSameScopeLayer,
  normalizeScopeLayer,
  parseScopeLayer,
} from "./scope-utils";

export type {
  EffectiveValidationContext,
  SchemaWriteContext,
  Unsubscribe,
  WeaverConfigService,
  WeaverConfigServiceOptions,
  WriteContext,
} from "./config-service-types";

const internalWriteToken: unique symbol = Symbol("weaver.internalWrite");
type InternalWriteContext = WriteContext & {
  readonly [internalWriteToken]?: true;
};
export async function createWeaverConfigService(
  options: WeaverConfigServiceOptions,
): Promise<WeaverConfigService> {
  const { providers: inputProviders, environment } = options;
  const logger = options.logger ?? consoleLogger;
  const flushDebounceMs = options.flushDebounceMs ?? 500;

  const layerData = new Map<string, Record<string, unknown>>();
  const dynamicScopeEntries = new Map<string, Record<string, unknown>>();
  const degradedProviders: string[] = [];
  let revision = "";
  const deltaHandlers = new Set<(delta: ConfigDelta) => void>();
  let batchDepth = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushAllDirty(): Promise<void> {
    for (const provider of providers) {
      if (provider.flush && provider.dirty) {
        await provider.flush();
      }
    }
  }

  function autoFlush(): void {
    if (batchDepth > 0) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushAllDirty().catch((err) =>
        logger.error("[config] flush failed:", err),
      );
    }, flushDebounceMs);
  }

  function checkRevision(
    expectedRevision: string | undefined,
  ): WriteResult | null {
    if (expectedRevision === undefined) return null;
    if (expectedRevision !== revision) {
      return {
        success: false,
        error: {
          code: "REVISION_CONFLICT",
          message: `Revision conflict: expected ${expectedRevision}, current is ${revision}`,
        },
      };
    }
    return null;
  }

  function isInternalWrite(opts?: InternalWriteContext): boolean {
    return opts?.[internalWriteToken] === true;
  }

  function withInternalWrite(opts?: WriteContext): InternalWriteContext {
    return { ...opts, [internalWriteToken]: true };
  }

  const activeProviders: ConfigurationStorageProvider[] = [];
  for (const provider of inputProviders) {
    try {
      const data = await provider.load();
      layerData.set(provider.id, data.entries);
      activeProviders.push(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[weaver] Provider "${provider.id}" failed to load: ${message}`,
      );
      degradedProviders.push(provider.id);
    }
  }

  const providers = activeProviders;

  function resolveProvider(
    layer: string,
  ): ConfigurationStorageProvider | undefined {
    for (const provider of providers) {
      if (provider.layer === layer) return provider;
    }

    const parsed = parseScopeLayer(layer);
    if (!parsed) return undefined;

    for (const provider of providers) {
      if (isSameScopeLayer(provider.layer, layer)) return provider;
    }

    return providers.find((provider) => provider.layer === parsed.scopeId);
  }

  const {
    getBaseEntries,
    getScopeState,
    getAllScopes,
    getMergedState,
    warmScopeLayers,
    getRevisionState,
  } = createConfigStateReader(providers, layerData, dynamicScopeEntries);

  const preflight = createConfigAdmission({
    service: () => service,
    environment,
    providers,
    layerData,
    dynamicScopeEntries,
    resolveProvider,
    getLayerValue,
    warmScopeLayers,
  });

  async function getLayerValue(layer: string, key: string): Promise<unknown> {
    const provider = resolveProvider(layer);
    if (!provider) return undefined;

    const parsedLayer = parseScopeLayer(layer);
    const isDynamicScopedLayer =
      parsedLayer !== null && provider.layer === parsedLayer.scopeId;
    const canonicalLayer = normalizeScopeLayer(layer);
    if (
      isDynamicScopedLayer &&
      hasScopedLayerIo(provider) &&
      !dynamicScopeEntries.has(canonicalLayer)
    ) {
      const data = await provider.loadLayer(canonicalLayer);
      dynamicScopeEntries.set(canonicalLayer, data.entries);
    }
    const entries = isDynamicScopedLayer
      ? dynamicScopeEntries.get(canonicalLayer)
      : layerData.get(provider.id);
    return deepGet(entries ?? {}, key);
  }

  function updateRevision(): void {
    revision = computeRevision(getRevisionState());
  }

  updateRevision();

  const pipeline = await createResolutionPipeline({
    getMergedState: () => publicConfigView.entries(getMergedState()),
    getBaseEntries: () => publicConfigView.entries(getBaseEntries()),
    secretBackend: options.secretBackend,
  });

  const fireDelta = createPublicDeltaEmitter(
    getMergedState,
    getBaseEntries,
    deltaHandlers,
  );

  const mutations = createConfigServiceMutations({
    service: () => service,
    environment,
    logger,
    layerData,
    dynamicScopeEntries,
    resolveProvider,
    isInternalWrite,
    checkRevision,
    preflight,
    pipeline,
    getBaseEntries,
    updateRevision,
    fireDelta,
    autoFlush,
  });

  const service: WeaverConfigService = {
    get providers() {
      return providers;
    },

    get degradedProviders() {
      return degradedProviders as ReadonlyArray<string>; // SAFETY: string[] is assignable to ReadonlyArray<string>
    },

    get revision() {
      return revision;
    },

    async resolveAll(opts?: {
      scopePath?: ScopeInstance[];
    }): Promise<ConfigSnapshot> {
      await warmScopeLayers(opts?.scopePath);
      const rawEntries = getBaseEntries();
      const entries = pipeline.resolveEntries(
        publicConfigView.entries(rawEntries),
      );
      const rawScopes = opts?.scopePath?.length
        ? {
            [buildScopePathString(opts.scopePath)]: getScopeState(
              opts.scopePath,
            ),
          }
        : getAllScopes();
      const scopes = publicConfigView.resolveScopes(
        rawScopes,
        rawEntries,
        (scopeEntries, state) =>
          pipeline.resolveEntries(scopeEntries, "", state),
      );

      return {
        entries,
        scopes,
        revision,
        timestamp: new Date().toISOString(),
      };
    },

    async get(
      key: string,
      opts?: { scopePath?: ScopeInstance[] },
    ): Promise<unknown> {
      if (isProtectedConfigPath(key)) return undefined;
      await warmScopeLayers(opts?.scopePath);
      const state = publicConfigView.entries(getMergedState(opts?.scopePath));
      const rawValue = deepGet(state, key);
      return pipeline.resolveValue(key, rawValue, state);
    },

    async getNamespace(
      prefix: string,
      opts?: { scopePath?: ScopeInstance[] },
    ): Promise<Record<string, unknown>> {
      if (isProtectedConfigPath(prefix)) return {};
      await warmScopeLayers(opts?.scopePath);
      const state = publicConfigView.entries(getMergedState(opts?.scopePath));
      const value = deepGet(state, prefix);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return pipeline.resolveEntries(
          value as Record<string, unknown>,
          prefix,
          state,
        );
      }
      return {};
    },

    async inspect(key) {
      const baseLayers = providers.map((provider) => ({
        layer: provider.layer,
        entries: layerData.get(provider.id) ?? {},
      }));
      const scopedLayers = [...dynamicScopeEntries].map(([layer, entries]) => ({
        layer: normalizeScopeLayer(layer),
        entries,
      }));
      return publicConfigView.inspect(key, [...baseLayers, ...scopedLayers]);
    },

    async reloadProvider(providerId: string): Promise<void> {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;
      const data = await provider.load();
      layerData.set(provider.id, data.entries);
      updateRevision();
    },

    set: mutations.set,
    remove: mutations.remove,

    onDelta(handler: (delta: ConfigDelta) => void) {
      deltaHandlers.add(handler);
      return () => {
        deltaHandlers.delete(handler);
      };
    },

    async batch<T>(fn: () => Promise<T>): Promise<T> {
      batchDepth++;
      try {
        const result = await fn();
        return result;
      } finally {
        batchDepth--;
        if (batchDepth === 0) {
          await flushAllDirty();
        }
      }
    },

    async flush(): Promise<void> {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await flushAllDirty();
    },

    async refreshProviders(): Promise<void> {
      for (const provider of providers) {
        if (provider.refresh) {
          await provider.refresh();
        }
        const data = await provider.load();
        layerData.set(provider.id, data.entries);
      }
      updateRevision();
    },

    setMany: createConfigBatch({
      service: () => service,
      isInternalWrite,
      checkRevision,
      resolveProvider,
      preflight,
      serialize: (task) => serializeConfigMutation(service, task),
      revision: () => revision,
      setValidated: mutations.setValidated,
    }),

    ...createRegisteredWriteOperations({
      defaultEnvironment: environment,
      getLayerValue,
      get: (key, getOptions) => service.get(key, getOptions),
      setPrepared: mutations.setPrepared,
      getRegistry: () => boundSchemaRegistry(service),
      serialize: (task) => serializeConfigMutation(service, task),
      isInternalWrite,
      checkRevision,
    }),
  };

  registerInternalConfigAccess(service, {
    ...createRegistryAccess({
      environment,
      configuredProviders: inputProviders,
      providers,
      degradedProviders,
      layerData,
      resolveProvider,
    }),
    read: async (key) => deepGet(getMergedState(), key),
    write: (layer, key, value, opts) =>
      service.set(layer, key, value, withInternalWrite(opts)),
    remove: (layer, key, opts) =>
      service.remove(layer, key, withInternalWrite(opts)),
  });

  return service;
}
