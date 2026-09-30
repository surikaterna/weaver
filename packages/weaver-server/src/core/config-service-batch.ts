import type {
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import type { WeaverConfigService, WriteContext } from "./config-service-types";
import type { Mutation } from "./config-write-admission";
import { snapshotSubmitted } from "./config-write-snapshot";
import { protectedConfigMutationError } from "./protected-config-paths";

interface BatchDependencies {
  readonly service: () => WeaverConfigService;
  readonly isInternalWrite: (context?: WriteContext) => boolean;
  readonly checkRevision: (expected: string | undefined) => WriteResult | null;
  readonly resolveProvider: (
    layer: string,
  ) => ConfigurationStorageProvider | undefined;
  readonly preflight: (
    layer: string,
    mutations: readonly Mutation[],
    context?: WriteContext,
  ) => Promise<WriteResult | null>;
  readonly serialize: <T>(task: () => Promise<T>) => Promise<T>;
  readonly setValidated: (
    layer: string,
    key: string,
    value: unknown,
    context?: WriteContext,
  ) => Promise<WriteResult>;
  readonly revision: () => string;
}

async function executeBatch(
  deps: BatchDependencies,
  layer: string,
  entries: Record<string, unknown>,
  opts?: WriteContext,
): Promise<WriteResult> {
  const conflict = deps.checkRevision(opts?.expectedRevision);
  if (conflict) return conflict;
  const mutations: Mutation[] = Object.entries(entries).map(([key, value]) => ({
    operation: "set",
    key,
    value,
  }));
  if (mutations.length === 0)
    return { success: true, revision: deps.revision() };
  const provider = deps.resolveProvider(layer);
  if (!provider)
    return {
      success: false,
      error: {
        code: "LAYER_NOT_FOUND",
        message: `No provider for layer "${layer}"`,
      },
    };
  if (!provider.writable)
    return {
      success: false,
      error: {
        code: "READONLY",
        message: `Provider for layer "${layer}" is read-only`,
      },
    };
  const error = await deps.preflight(layer, mutations, opts);
  if (error) return error;
  return deps.service().batch(async () => {
    for (const [key, value] of Object.entries(entries)) {
      const result = await deps.setValidated(layer, key, value, opts);
      if (!result.success) return result;
    }
    return { success: true, revision: deps.revision() };
  });
}

export function createConfigBatch(
  deps: BatchDependencies,
): WeaverConfigService["setMany"] {
  return async (layer, entries, opts) => {
    for (const key of Object.keys(entries)) {
      if (deps.isInternalWrite(opts)) break;
      const protectedError = protectedConfigMutationError(key);
      if (protectedError) return protectedError;
    }
    if (deps.isInternalWrite(opts)) {
      return deps.service().batch(async () => {
        for (const [key, value] of Object.entries(entries)) {
          const result = await deps.service().set(layer, key, value, opts);
          if (!result.success) return result;
        }
        return { success: true, revision: deps.revision() };
      });
    }
    const snapshot = snapshotSubmitted(entries);
    if (!snapshot.success) return snapshot.result;
    return deps.serialize(() =>
      executeBatch(deps, layer, snapshot.value, opts),
    );
  };
}
