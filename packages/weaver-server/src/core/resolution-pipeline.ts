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
  resolveValue(
    key: string,
    rawValue: unknown,
    resolutionState?: Record<string, unknown>,
  ): unknown;
  /** Resolve all markers in an entries object recursively. */
  resolveEntries(
    entries: Record<string, unknown>,
    prefix?: string,
    resolutionState?: Record<string, unknown>,
  ): Record<string, unknown>;
  /** Rebuild internal mount map after state changes. */
  rebuildMountMap(): void;
  /** Refresh secret cache (fire-and-forget safe). */
  refreshSecrets(entries: Readonly<Record<string, unknown>>): Promise<void>;
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

interface ResolutionPipelineState {
  readonly getMergedState: () => Record<string, unknown>;
  readonly getBaseEntries: () => Record<string, unknown>;
  mountMap: ReadonlyMap<string, string>;
  readonly secretResolver: SecretResolver | null;
}

export async function createResolutionPipeline(
  options: ResolutionPipelineOptions,
): Promise<ResolutionPipeline> {
  const { getMergedState, getBaseEntries, secretBackend } = options;
  const state: ResolutionPipelineState = {
    getMergedState,
    getBaseEntries,
    mountMap: buildMountMap(getBaseEntries()),
    secretResolver: secretBackend
      ? await createSecretResolver(getBaseEntries(), { backend: secretBackend })
      : null,
  };
  return {
    resolveValue: (key, value, entries) =>
      resolveValue(state, key, value, entries),
    resolveEntries: (entries, prefix, resolutionState) =>
      resolveEntries(state, entries, prefix, resolutionState),
    rebuildMountMap: () => rebuildMountMap(state),
    refreshSecrets: (entries) => refreshSecrets(state, entries),
    get hasSecretResolver() {
      return state.secretResolver !== null;
    },
  };
}

function rebuildMountMap(state: ResolutionPipelineState): void {
  state.mountMap = buildMountMap(state.getBaseEntries());
}

function resolveValue(
  pipeline: ResolutionPipelineState,
  key: string,
  rawValue: unknown,
  resolutionState?: Record<string, unknown>,
): unknown {
  let resolvedKey = key;
  const state = resolutionState ?? pipeline.getMergedState();
  const mountMap = resolutionState ? buildMountMap(state) : pipeline.mountMap;
  if (isConfigMount(rawValue)) {
    const result = resolveMountedValue(key, mountMap, (k) => deepGet(state, k));
    if (!result.ok) return undefined;
    rawValue = result.resolution.value;
    resolvedKey = result.resolution.chain.at(-1) ?? key;
  }
  if (isSecretReference(rawValue)) {
    return pipeline.secretResolver?.getResolved(resolvedKey) ?? rawValue;
  }
  return rawValue;
}

function resolveEntries(
  pipeline: ResolutionPipelineState,
  entries: Record<string, unknown>,
  prefix = "",
  resolutionState?: Record<string, unknown>,
): Record<string, unknown> {
  const state = resolutionState ?? pipeline.getMergedState();
  const mountMap = resolutionState ? buildMountMap(state) : pipeline.mountMap;
  return resolveEntryObject(pipeline, entries, prefix, state, mountMap);
}

function resolveEntryObject(
  pipeline: ResolutionPipelineState,
  entries: Record<string, unknown>,
  prefix: string,
  state: Record<string, unknown>,
  mountMap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    result[key] = resolveEntryValue(pipeline, value, fullKey, state, mountMap);
  }
  return result;
}

function resolveEntryValue(
  pipeline: ResolutionPipelineState,
  value: unknown,
  key: string,
  state: Record<string, unknown>,
  mountMap: ReadonlyMap<string, string>,
): unknown {
  if (isConfigMount(value)) {
    return resolveEntryMount(pipeline, key, state, mountMap);
  }
  if (isSecretReference(value)) {
    return pipeline.secretResolver?.getResolved(key) ?? value;
  }
  if (isRecord(value)) {
    return resolveEntryObject(pipeline, value, key, state, mountMap);
  }
  return value;
}

function resolveEntryMount(
  pipeline: ResolutionPipelineState,
  key: string,
  state: Record<string, unknown>,
  mountMap: ReadonlyMap<string, string>,
): unknown {
  const result = resolveMountedValue(key, mountMap, (mountedKey) =>
    deepGet(state, mountedKey),
  );
  if (!result.ok) return undefined;
  const targetKey = result.resolution.chain.at(-1) ?? key;
  const resolved = result.resolution.value;
  if (!isSecretReference(resolved)) return resolved;
  return pipeline.secretResolver?.getResolved(targetKey) ?? resolved;
}

async function refreshSecrets(
  state: ResolutionPipelineState,
  entries: Readonly<Record<string, unknown>>,
): Promise<void> {
  await state.secretResolver?.refresh(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
