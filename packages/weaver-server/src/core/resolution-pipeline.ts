// Resolution pipeline — resolves ConfigMount and SecretReference markers in config values

import { buildPath, deepGet, parsePath } from "@weaver-conf/config-engine";
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
  /** Refresh the secret cache before resolving this context. */
  refreshSecrets(entries: Readonly<Record<string, unknown>>): Promise<void>;
  /** Release context-local resolver resources. */
  dispose(): void;
  /** Whether a secret resolver is active. */
  readonly hasSecretResolver: boolean;
}

export interface ResolutionPipelineOptions {
  /** Returns the merged state for value lookups during mount resolution. */
  getMergedState: () => Record<string, unknown>;
  /** Returns the entries owned by this pipeline context for marker scanning. */
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
    return resolveNode(rawValue, parsePath(key), getMergedState(), {
      activeContainers: new Set(),
      activeMounts: new Set(),
    });
  }

  function resolveEntries(
    entries: Record<string, unknown>,
    prefix = "",
    lookupEntries = getMergedState(),
  ): Record<string, unknown> {
    return resolveRecord(
      entries,
      prefix ? parsePath(prefix) : [],
      lookupEntries,
      {
        activeContainers: new Set(),
        activeMounts: new Set(),
      },
    );
  }

  interface ResolutionState {
    readonly activeContainers: Set<object>;
    readonly activeMounts: Set<string>;
  }

  function resolveRecord(
    entries: Record<string, unknown>,
    path: readonly string[],
    lookupEntries: Record<string, unknown>,
    state: ResolutionState,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (state.activeContainers.has(entries)) return result;
    state.activeContainers.add(entries);
    try {
      for (const [key, value] of Object.entries(entries)) {
        result[key] = resolveNode(value, [...path, key], lookupEntries, state);
      }
    } finally {
      state.activeContainers.delete(entries);
    }
    return result;
  }

  function resolveNode(
    value: unknown,
    path: readonly string[],
    lookupEntries: Record<string, unknown>,
    state: ResolutionState,
  ): unknown {
    if (isConfigMount(value)) {
      return resolveMount(path, lookupEntries, state);
    }
    if (isSecretReference(value)) {
      return secretResolver?.getResolved(buildPath(path)) ?? value;
    }
    if (Array.isArray(value)) {
      if (state.activeContainers.has(value)) return undefined;
      state.activeContainers.add(value);
      try {
        return value.map((item, index) =>
          resolveNode(item, [...path, String(index)], lookupEntries, state),
        );
      } finally {
        state.activeContainers.delete(value);
      }
    }
    if (!isRecord(value)) return value;
    return resolveRecord(value, path, lookupEntries, state);
  }

  function resolveMount(
    path: readonly string[],
    lookupEntries: Record<string, unknown>,
    state: ResolutionState,
  ): unknown {
    const key = buildPath(path);
    const resolved = resolveMountedValue(key, mountMap, (source) =>
      deepGet(lookupEntries, source),
    );
    if (!resolved.ok) return undefined;
    const chain = resolved.resolution.chain;
    if (chain.some((item) => state.activeMounts.has(item))) return undefined;
    for (const item of chain) state.activeMounts.add(item);
    try {
      const terminal = chain.at(-1) ?? key;
      return resolveNode(
        resolved.resolution.value,
        parsePath(terminal),
        lookupEntries,
        state,
      );
    } finally {
      for (const item of chain) state.activeMounts.delete(item);
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
