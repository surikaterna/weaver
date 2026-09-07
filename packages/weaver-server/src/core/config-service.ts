// WeaverConfigService — server-side config service wrapping storage providers

import {
  consoleLogger,
  deepGet,
  deepRemove,
  deepSet,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  ScopeInstance,
  WriteResult,
} from "@weaver-conf/config-types";
import type { ConfigDelta, ConfigSnapshot } from "../types/index";
import { registerInternalConfigAccess } from "./config-service-internal";
import {
  prepareRegisteredObjectWrite,
  prepareRegisteredPatchWrite,
  validateRegisteredEffectiveConfiguration,
} from "./config-service-schema-writes";
import type {
  EffectiveValidationContext,
  SchemaWriteContext,
  WeaverConfigService,
  WeaverConfigServiceOptions,
  WriteContext,
} from "./config-service-types";
import {
  computeConfigRevision,
  createConfigServiceState,
  effectiveWriteState,
  hasScopedLayerIo,
} from "./config-service-write-state";
import {
  filterProtectedConfigEntries,
  filterProtectedConfigScopes,
  isProtectedConfigPath,
  protectedConfigMutationError,
} from "./protected-config-paths";
import {
  type ConfigInspectionLayer,
  inspectPublicConfig,
} from "./public-config-inspection";
import { createResolutionPipeline } from "./resolution-pipeline";
import {
  registerSchemaBoundaryHost,
  validateBoundRemove,
  validateBoundSet,
  validateBoundSetMany,
} from "./schema-write-boundary";
import {
  buildScopePathString,
  isSameScopeLayer,
  normalizeScopeLayer,
  parseScopeLayer,
} from "./scope-utils";

export type { Unsubscribe } from "./config-service-types";
export type {
  EffectiveValidationContext,
  SchemaWriteContext,
  WeaverConfigService,
  WeaverConfigServiceOptions,
  WriteContext,
};

const SIZE_WARNING = 1_048_576; // 1MB
const internalWriteToken: unique symbol = Symbol("weaver.internalWrite");
const validatedWriteToken: unique symbol = Symbol("weaver.validatedWrite");

type InternalWriteContext = WriteContext & {
  readonly [internalWriteToken]?: true;
  readonly [validatedWriteToken]?: true;
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

  function withValidatedWrite(opts?: WriteContext): InternalWriteContext {
    const { expectedRevision: _expectedRevision, ...context } = opts ?? {};
    return { ...context, [validatedWriteToken]: true };
  }

  function isValidatedWrite(opts?: InternalWriteContext): boolean {
    return opts?.[validatedWriteToken] === true;
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
    getAllScopes,
    getBaseEntries,
    getLayerEntries,
    getLayerValue,
    getMergedState,
    getScopeState,
  } = createConfigServiceState({
    providers,
    layerData,
    dynamicScopeEntries,
    resolveProvider,
    hasScopedLayerIo,
  });

  async function warmScopeLayers(scopePath?: ScopeInstance[]): Promise<void> {
    if (!scopePath?.length) return;

    for (const scope of scopePath) {
      const normalizedScopeLayer = `${scope.scopeId}:${scope.value}`;

      for (const provider of providers) {
        if (!hasScopedLayerIo(provider)) continue;
        if (provider.layer !== scope.scopeId) continue;
        if (dynamicScopeEntries.has(normalizedScopeLayer)) continue;

        const data = await provider.loadLayer(normalizedScopeLayer);
        dynamicScopeEntries.set(normalizedScopeLayer, data.entries);
      }
    }
  }

  function getRevisionState(): Record<string, unknown> {
    return {
      base: getBaseEntries(),
      scopes: getAllScopes(),
    };
  }

  function updateRevision(): void {
    revision = computeConfigRevision(getRevisionState());
  }

  updateRevision();

  // --- Mount + Secret resolution pipeline ---
  const pipeline = await createResolutionPipeline({
    getMergedState: () => filterProtectedConfigEntries(getMergedState()),
    getBaseEntries: () => filterProtectedConfigEntries(getBaseEntries()),
    secretBackend: options.secretBackend,
  });

  function fireDelta(delta: ConfigDelta): void {
    for (const handler of deltaHandlers) {
      handler(delta);
    }
  }

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
      const rawEntries = filterProtectedConfigEntries(getBaseEntries());
      const entries = pipeline.resolveEntries(rawEntries);
      const rawScopes = opts?.scopePath?.length
        ? {
            [buildScopePathString(opts.scopePath)]: getScopeState(
              opts.scopePath,
            ),
          }
        : getAllScopes();
      const scopes = filterProtectedConfigScopes(rawScopes);

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
      const state = filterProtectedConfigEntries(
        getMergedState(opts?.scopePath),
      );
      const rawValue = deepGet(state, key);
      return pipeline.resolveValue(key, rawValue);
    },

    async getNamespace(
      prefix: string,
      opts?: { scopePath?: ScopeInstance[] },
    ): Promise<Record<string, unknown>> {
      if (isProtectedConfigPath(prefix)) return {};
      await warmScopeLayers(opts?.scopePath);
      const state = filterProtectedConfigEntries(
        getMergedState(opts?.scopePath),
      );
      const value = deepGet(state, prefix);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return pipeline.resolveEntries(
          value as Record<string, unknown>,
          prefix,
        );
      }
      return {};
    },

    async inspect(key: string) {
      const layers: ConfigInspectionLayer[] = providers.map((provider) => ({
        layer: provider.layer,
        entries: layerData.get(provider.id) ?? {},
      }));
      for (const [layer, entries] of dynamicScopeEntries) {
        layers.push({ layer: normalizeScopeLayer(layer), entries });
      }
      return inspectPublicConfig(key, layers);
    },

    async reloadProvider(providerId: string): Promise<void> {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;
      const data = await provider.load();
      layerData.set(provider.id, data.entries);
      updateRevision();
    },

    async set(
      layer: string,
      key: string,
      value: unknown,
      opts?: WriteContext,
    ): Promise<WriteResult> {
      if (!isInternalWrite(opts)) {
        const protectedError = protectedConfigMutationError(key);
        if (protectedError) return protectedError;
      }

      const revConflict = checkRevision(opts?.expectedRevision);
      if (revConflict) return revConflict;

      const provider = resolveProvider(layer);
      if (!provider) {
        return {
          success: false,
          error: {
            code: "LAYER_NOT_FOUND",
            message: `No provider for layer "${layer}"`,
          },
        };
      }
      if (!provider.writable) {
        return {
          success: false,
          error: {
            code: "READONLY",
            message: `Provider for layer "${layer}" is read-only`,
          },
        };
      }

      const parsedLayer = parseScopeLayer(layer);
      const isDynamicScopedLayer =
        parsedLayer !== null && provider.layer === parsedLayer.scopeId;
      const canonicalLayer = normalizeScopeLayer(layer);
      if (isDynamicScopedLayer) await getLayerValue(layer, key);

      if (!isInternalWrite(opts) && !isValidatedWrite(opts)) {
        const validation = validateBoundSet(service, key, value, opts, {
          layerEntries: getLayerEntries(
            provider,
            canonicalLayer,
            isDynamicScopedLayer,
          ),
        });
        if (validation) return validation;
      }

      if (typeof value === "string" && value.length > SIZE_WARNING) {
        logger.warn(
          `[weaver] Value for key "${key}" exceeds 1MB (${value.length} bytes)`,
        );
      }

      let result: WriteResult;
      if (isDynamicScopedLayer) {
        if (hasScopedLayerIo(provider)) {
          result = await provider.writeLayer(canonicalLayer, key, value);
        } else {
          return {
            success: false,
            error: {
              code: "LAYER_NOT_FOUND",
              message: `Provider for base scope layer "${provider.layer}" does not support scoped writes for "${layer}"`,
            },
          };
        }
      } else {
        result = await provider.write(key, value);
      }

      if (!result.success) return result;

      if (isDynamicScopedLayer) {
        const entries = {
          ...(dynamicScopeEntries.get(canonicalLayer) ?? {}),
        };
        deepSet(entries, key, value);
        dynamicScopeEntries.set(canonicalLayer, entries);
      } else {
        const entries = layerData.get(provider.id) ?? {};
        deepSet(entries, key, value);
        layerData.set(provider.id, entries);
      }
      updateRevision();
      pipeline.rebuildMountMap();
      if (pipeline.hasSecretResolver) {
        pipeline
          .refreshSecrets(getBaseEntries())
          .catch((err) => logger.error("[config] secret refresh failed:", err));
      }

      const delta: ConfigDelta = {
        action: "set",
        key,
        value,
        layer,
        environment: opts?.environment ?? environment,
        timestamp: new Date().toISOString(),
      };
      if (!isInternalWrite(opts)) fireDelta(delta);

      autoFlush();
      return result;
    },

    async remove(
      layer: string,
      key: string,
      opts?: WriteContext,
    ): Promise<WriteResult> {
      if (!isInternalWrite(opts)) {
        const protectedError = protectedConfigMutationError(key);
        if (protectedError) return protectedError;
      }

      const revConflict = checkRevision(opts?.expectedRevision);
      if (revConflict) return revConflict;

      const provider = resolveProvider(layer);
      if (!provider) {
        return {
          success: false,
          error: {
            code: "LAYER_NOT_FOUND",
            message: `No provider for layer "${layer}"`,
          },
        };
      }
      if (!provider.writable) {
        return {
          success: false,
          error: {
            code: "READONLY",
            message: `Provider for layer "${layer}" is read-only`,
          },
        };
      }

      const parsedLayer = parseScopeLayer(layer);
      const isDynamicScopedLayer =
        parsedLayer !== null && provider.layer === parsedLayer.scopeId;
      const canonicalLayer = normalizeScopeLayer(layer);
      if (isDynamicScopedLayer) await getLayerValue(layer, key);

      if (!isInternalWrite(opts)) {
        const layerEntries = getLayerEntries(
          provider,
          canonicalLayer,
          isDynamicScopedLayer,
        );
        const candidate = structuredClone(layerEntries);
        deepRemove(candidate, key);
        const validation = validateBoundRemove(service, key, opts, {
          layerEntries,
          effectiveEntries: effectiveWriteState({
            providers,
            layerData,
            provider,
            canonicalLayer,
            candidate,
            ...(opts?.scopePath ? { scopePath: opts.scopePath } : {}),
            getScopeState,
          }),
        });
        if (validation) return validation;
      }

      let result: WriteResult;
      if (isDynamicScopedLayer) {
        if (hasScopedLayerIo(provider)) {
          result = await provider.removeLayer(canonicalLayer, key);
        } else {
          return {
            success: false,
            error: {
              code: "LAYER_NOT_FOUND",
              message: `Provider for base scope layer "${provider.layer}" does not support scoped removes for "${layer}"`,
            },
          };
        }
      } else {
        result = await provider.remove(key);
      }

      if (!result.success) return result;

      if (isDynamicScopedLayer) {
        const entries = {
          ...(dynamicScopeEntries.get(canonicalLayer) ?? {}),
        };
        deepRemove(entries, key);
        dynamicScopeEntries.set(canonicalLayer, entries);
      } else {
        const entries = layerData.get(provider.id) ?? {};
        deepRemove(entries, key);
        layerData.set(provider.id, entries);
      }
      updateRevision();
      pipeline.rebuildMountMap();
      if (pipeline.hasSecretResolver) {
        pipeline
          .refreshSecrets(getBaseEntries())
          .catch((err) => logger.error("[config] secret refresh failed:", err));
      }

      const delta: ConfigDelta = {
        action: "remove",
        key,
        value: null,
        layer,
        environment: opts?.environment ?? environment,
        timestamp: new Date().toISOString(),
      };
      if (!isInternalWrite(opts)) fireDelta(delta);

      autoFlush();
      return result;
    },

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

    async setMany(
      layer: string,
      entries: Record<string, unknown>,
      opts?: WriteContext,
    ): Promise<WriteResult> {
      if (!isInternalWrite(opts)) {
        for (const key of Object.keys(entries)) {
          const protectedError = protectedConfigMutationError(key);
          if (protectedError) return protectedError;
        }
      }
      if (Object.keys(entries).length === 0) return { success: true, revision };

      const revConflict = checkRevision(opts?.expectedRevision);
      if (revConflict) return revConflict;
      const provider = resolveProvider(layer);
      if (!provider) {
        return {
          success: false,
          error: {
            code: "LAYER_NOT_FOUND",
            message: `No provider for layer "${layer}"`,
          },
        };
      }
      const parsedLayer = parseScopeLayer(layer);
      const dynamic =
        parsedLayer !== null && provider.layer === parsedLayer.scopeId;
      const canonicalLayer = normalizeScopeLayer(layer);
      if (dynamic) await getLayerValue(layer, "");
      const validation = isInternalWrite(opts)
        ? null
        : validateBoundSetMany(
            service,
            entries,
            opts,
            getLayerEntries(provider, canonicalLayer, dynamic),
          );
      if (validation) return validation;

      return service.batch(async () => {
        for (const [key, value] of Object.entries(entries)) {
          const result = await service.set(
            layer,
            key,
            value,
            isInternalWrite(opts) ? opts : withValidatedWrite(opts),
          );
          if (!result.success) return result;
        }
        return { success: true, revision };
      });
    },

    async setRegisteredObject(
      layer: string,
      path: string,
      value: unknown,
      opts: SchemaWriteContext,
    ): Promise<WriteResult> {
      if (!isInternalWrite(opts)) {
        const protectedError = protectedConfigMutationError(path);
        if (protectedError) return protectedError;
      }

      const revConflict = checkRevision(opts.expectedRevision);
      if (revConflict) return revConflict;

      const prepared = await prepareRegisteredObjectWrite(
        path,
        value,
        opts,
        environment,
      );
      if (!prepared.success) return prepared.result;
      return service.set(layer, prepared.key, prepared.value, opts);
    },

    async patchRegisteredPath(
      layer: string,
      path: string,
      value: unknown,
      opts: SchemaWriteContext,
    ): Promise<WriteResult> {
      if (!isInternalWrite(opts)) {
        const protectedError = protectedConfigMutationError(path);
        if (protectedError) return protectedError;
      }

      const revConflict = checkRevision(opts.expectedRevision);
      if (revConflict) return revConflict;

      const prepared = await prepareRegisteredPatchWrite(
        path,
        value,
        opts,
        environment,
        (key) => getLayerValue(layer, key),
      );
      if (!prepared.success) return prepared.result;
      return service.set(layer, prepared.key, prepared.value, opts);
    },

    async validateRegisteredEffective(path, opts) {
      const getOptions = opts.scopePath
        ? { scopePath: opts.scopePath }
        : undefined;
      return validateRegisteredEffectiveConfiguration(
        path,
        opts,
        environment,
        (key) => service.get(key, getOptions),
      );
    },
  };

  registerInternalConfigAccess(service, {
    read: async (key) => deepGet(getMergedState(), key),
    write: (layer, key, value, opts) =>
      service.set(layer, key, value, withInternalWrite(opts)),
    remove: (layer, key, opts) =>
      service.remove(layer, key, withInternalWrite(opts)),
  });
  registerSchemaBoundaryHost(service, environment);

  return service;
}
