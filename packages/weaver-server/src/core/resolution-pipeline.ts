// Resolution pipeline — resolves ConfigMount and SecretReference markers in config values

import { deepGet } from "@weaver-conf/config-engine";
import type {
  SecretBackend,
  SecretResolver,
} from "@weaver-conf/config-runtime";
import {
  buildMountMap,
  createSecretResolver,
  resolveMountedValue,
} from "@weaver-conf/config-runtime";
import { isConfigMount, isSecretReference } from "@weaver-conf/config-types";

export interface ResolutionPipeline {
  /** Resolve a single keyed value through mounts then secrets. */
  resolveValue(key: string, rawValue: unknown): unknown;
  /** Resolve all markers in an entries object recursively. */
  resolveEntries(
    entries: Record<string, unknown>,
    prefix?: string,
    lookupEntries?: Record<string, unknown>,
  ): Record<string, unknown>;
  /** Rebuild internal mount map after state changes. */
  rebuildMountMap(): void;
  /** Refresh secret cache (fire-and-forget safe). */
  refreshSecrets(entries: Readonly<Record<string, unknown>>): Promise<void>;
  /** Release context-local resolver resources. */
  dispose(): void;
  /** Whether a secret resolver is active. */
  readonly hasSecretResolver: boolean;
}

export interface ResolutionPipelineOptions {
  /** Returns the merged state for value lookups during mount resolution. */
  getMergedState: () => Record<string, unknown>;
  /** Returns base (non-scoped) entries for mount map + secret scanning. */
  getBaseEntries: () => Record<string, unknown>;
  /** Optional secret backend for resolving SecretReference markers. */
  secretBackend?: SecretBackend | undefined;
}

export async function createResolutionPipeline(
  options: ResolutionPipelineOptions,
): Promise<ResolutionPipeline> {
  const { getMergedState, getBaseEntries, secretBackend } = options;

  let mountMap: ReadonlyMap<string, string> = buildMountMap(getBaseEntries());
  let secretResolver: SecretResolver | null = null;

  if (secretBackend) {
    secretResolver = await createSecretResolver(getBaseEntries(), {
      backend: secretBackend,
    });
  }

  function rebuildMountMap(): void {
    mountMap = buildMountMap(getBaseEntries());
  }

  function resolveValue(key: string, rawValue: unknown): unknown {
    let resolvedKey = key;

    if (isConfigMount(rawValue)) {
      const result = resolveMountedValue(key, mountMap, (k) =>
        deepGet(getMergedState(), k),
      );
      if (!result.ok) return undefined;
      rawValue = result.resolution.value;
      resolvedKey =
        result.resolution.chain[result.resolution.chain.length - 1] ?? key;
    }

    if (isSecretReference(rawValue)) {
      return secretResolver?.getResolved(resolvedKey) ?? rawValue;
    }

    return rawValue;
  }

  function resolveEntries(
    entries: Record<string, unknown>,
    prefix = "",
    lookupEntries = getMergedState(),
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entries)) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      if (isConfigMount(v)) {
        const mountResult = resolveMountedValue(fullKey, mountMap, (mk) =>
          deepGet(lookupEntries, mk),
        );
        if (!mountResult.ok) {
          result[k] = undefined;
          continue;
        }
        const targetKey =
          mountResult.resolution.chain[
            mountResult.resolution.chain.length - 1
          ] ?? fullKey;
        const resolved = mountResult.resolution.value;
        if (isSecretReference(resolved)) {
          result[k] = secretResolver?.getResolved(targetKey) ?? resolved;
        } else {
          result[k] = resolved;
        }
      } else if (isSecretReference(v)) {
        result[k] = secretResolver?.getResolved(fullKey) ?? v;
      } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        result[k] = resolveEntries(
          v as Record<string, unknown>,
          fullKey,
          lookupEntries,
        );
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  async function refreshSecrets(
    entries: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (secretResolver) {
      await secretResolver.refresh(entries);
    }
  }

  return {
    resolveValue,
    resolveEntries,
    rebuildMountMap,
    refreshSecrets,
    dispose() {
      secretResolver?.dispose();
    },
    get hasSecretResolver() {
      return secretResolver !== null;
    },
  };
}
