import {
  deepRemove,
  deepSet,
  type WeaverLogger,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import type { ConfigDelta } from "../types/index";
import {
  hasScopedLayerIo,
  serializeConfigMutation,
} from "./config-service-internal";
import type { WeaverConfigService, WriteContext } from "./config-service-types";
import type { Mutation } from "./config-write-admission";
import { snapshotSubmitted } from "./config-write-snapshot";
import { protectedConfigMutationError } from "./protected-config-paths";
import { publicConfigView } from "./public-config-inspection";
import type { createResolutionPipeline } from "./resolution-pipeline";
import { normalizeScopeLayer, parseScopeLayer } from "./scope-utils";

const queuedToken: unique symbol = Symbol("weaver.queuedWrite");
const validatedBatchToken: unique symbol = Symbol("weaver.validatedBatch");
const preparedToken: unique symbol = Symbol("weaver.preparedWrite");
const SIZE_WARNING = 1_048_576;

type MutationContext = WriteContext & {
  readonly [queuedToken]?: true;
  readonly [validatedBatchToken]?: true;
  readonly [preparedToken]?: { readonly key: string; readonly value: unknown };
};

interface Dependencies {
  readonly service: () => WeaverConfigService;
  readonly environment: string;
  readonly logger: WeaverLogger;
  readonly layerData: Map<string, Record<string, unknown>>;
  readonly dynamicScopeEntries: Map<string, Record<string, unknown>>;
  readonly resolveProvider: (
    layer: string,
  ) => ConfigurationStorageProvider | undefined;
  readonly isInternalWrite: (context?: WriteContext) => boolean;
  readonly checkRevision: (expected: string | undefined) => WriteResult | null;
  readonly preflight: (
    layer: string,
    mutations: readonly Mutation[],
    context?: WriteContext,
  ) => Promise<WriteResult | null>;
  readonly pipeline: Awaited<ReturnType<typeof createResolutionPipeline>>;
  readonly getBaseEntries: () => Record<string, unknown>;
  readonly updateRevision: () => void;
  readonly fireDelta: (delta: ConfigDelta) => void;
  readonly autoFlush: () => void;
}

function providerError(
  layer: string,
  code: string,
  message: string,
): WriteResult {
  return { success: false, error: { code, message: `${message} "${layer}"` } };
}

function publishWrite(
  deps: Dependencies,
  provider: ConfigurationStorageProvider,
  layer: string,
  key: string,
  value: unknown,
  operation: "set" | "remove",
  opts?: MutationContext,
): void {
  const parsed = parseScopeLayer(layer);
  const dynamic = parsed !== null && provider.layer === parsed.scopeId;
  const canonical = normalizeScopeLayer(layer);
  const entries = dynamic
    ? { ...(deps.dynamicScopeEntries.get(canonical) ?? {}) }
    : (deps.layerData.get(provider.id) ?? {});
  if (operation === "set") deepSet(entries, key, value);
  else deepRemove(entries, key);
  if (dynamic) deps.dynamicScopeEntries.set(canonical, entries);
  else deps.layerData.set(provider.id, entries);
  deps.updateRevision();
  deps.pipeline.rebuildMountMap();
  if (deps.pipeline.hasSecretResolver) {
    deps.pipeline
      .refreshSecrets(publicConfigView.entries(deps.getBaseEntries()))
      .catch((error) =>
        deps.logger.error("[config] secret refresh failed:", error),
      );
  }
  if (!deps.isInternalWrite(opts))
    deps.fireDelta({
      action: operation,
      key,
      value: operation === "set" ? value : null,
      layer,
      environment: opts?.environment ?? deps.environment,
      timestamp: new Date().toISOString(),
    });
  deps.autoFlush();
}

async function persistWrite(
  provider: ConfigurationStorageProvider,
  layer: string,
  key: string,
  value: unknown,
  operation: "set" | "remove",
): Promise<WriteResult> {
  const parsed = parseScopeLayer(layer);
  const dynamic = parsed !== null && provider.layer === parsed.scopeId;
  if (dynamic) {
    if (!hasScopedLayerIo(provider)) {
      return providerError(
        layer,
        "LAYER_NOT_FOUND",
        `Provider for base scope layer "${provider.layer}" does not support scoped ${operation === "set" ? "writes" : "removes"} for`,
      );
    }
    const canonical = normalizeScopeLayer(layer);
    return operation === "set"
      ? provider.writeLayer(canonical, key, value)
      : provider.removeLayer(canonical, key);
  }
  return operation === "set"
    ? provider.write(key, value)
    : provider.remove(key);
}

async function verifyMutation(
  deps: Dependencies,
  layer: string,
  key: string,
  value: unknown,
  operation: "set" | "remove",
  opts?: MutationContext,
): Promise<
  | { readonly success: true; readonly provider: ConfigurationStorageProvider }
  | { readonly success: false; readonly result: WriteResult }
> {
  const conflict = deps.checkRevision(opts?.expectedRevision);
  if (conflict) return { success: false, result: conflict };
  const provider = deps.resolveProvider(layer);
  if (!provider)
    return {
      success: false,
      result: providerError(layer, "LAYER_NOT_FOUND", "No provider for layer"),
    };
  if (!provider.writable)
    return {
      success: false,
      result: {
        success: false,
        error: {
          code: "READONLY",
          message: `Provider for layer "${layer}" is read-only`,
        },
      },
    };
  if (!deps.isInternalWrite(opts) && !opts?.[validatedBatchToken]) {
    const target = opts?.[preparedToken];
    const mutation: Mutation = {
      operation,
      key,
      value,
      ...(target
        ? {
            admissionKey: target.key,
            admissionValue: target.value,
            dedicated: true,
          }
        : {}),
    };
    const denied = await deps.preflight(layer, [mutation], opts);
    if (denied) return { success: false, result: denied };
  }
  return { success: true, provider };
}

async function mutate(
  deps: Dependencies,
  layer: string,
  key: string,
  value: unknown,
  operation: "set" | "remove",
  opts?: MutationContext,
): Promise<WriteResult> {
  if (!deps.isInternalWrite(opts)) {
    const protectedError = protectedConfigMutationError(key);
    if (protectedError) return protectedError;
  }
  if (!deps.isInternalWrite(opts) && !opts?.[queuedToken]) {
    const snapshot = snapshotSubmitted(value);
    if (!snapshot.success) return snapshot.result;
    const queued: MutationContext = { ...opts, [queuedToken]: true };
    return serializeConfigMutation(deps.service(), () =>
      mutate(deps, layer, key, snapshot.value, operation, queued),
    );
  }
  const verified = await verifyMutation(
    deps,
    layer,
    key,
    value,
    operation,
    opts,
  );
  if (!verified.success) return verified.result;
  if (
    operation === "set" &&
    typeof value === "string" &&
    value.length > SIZE_WARNING
  ) {
    deps.logger.warn(
      `[weaver] Value for key "${key}" exceeds 1MB (${value.length} bytes)`,
    );
  }
  const result = await persistWrite(
    verified.provider,
    layer,
    key,
    value,
    operation,
  );
  if (!result.success) return result;
  publishWrite(deps, verified.provider, layer, key, value, operation, opts);
  return result;
}

export function createConfigServiceMutations(deps: Dependencies) {
  return {
    set: (layer: string, key: string, value: unknown, opts?: WriteContext) =>
      mutate(deps, layer, key, value, "set", opts),
    remove: (layer: string, key: string, opts?: WriteContext) =>
      mutate(deps, layer, key, undefined, "remove", opts),
    setValidated: (
      layer: string,
      key: string,
      value: unknown,
      opts?: WriteContext,
    ) => {
      const validated: MutationContext = {
        ...opts,
        [queuedToken]: true,
        [validatedBatchToken]: true,
      };
      return mutate(deps, layer, key, value, "set", validated);
    },
    setPrepared: (
      layer: string,
      key: string,
      value: unknown,
      path: string,
      input: unknown,
      opts: WriteContext,
    ) => {
      const prepared: MutationContext = {
        ...opts,
        [queuedToken]: true,
        [preparedToken]: { key: path, value: input },
      };
      return mutate(deps, layer, key, value, "set", prepared);
    },
  };
}
