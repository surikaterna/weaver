import { deepGet, deepMerge } from "@weaver-conf/config-engine";
import type {
  ConfigDelta,
  ConfigMount,
  ConfigurationInspection,
} from "@weaver-conf/config-types";
import { isConfigMount } from "@weaver-conf/config-types";
import {
  filterProtectedConfigEntries,
  isProtectedConfigPath,
} from "./protected-config-paths";

export interface ConfigInspectionLayer {
  readonly layer: string;
  readonly entries: Record<string, unknown>;
}

export const publicConfigView = {
  entries: projectPublicEntries,
  resolveScopes: resolvePublicConfigScopes,
  delta: projectPublicDelta,
  inspect: inspectPublicConfig,
};

const omitted = Symbol("omitted public config value");

interface MountTaintClassifier {
  isTainted(mount: ConfigMount): boolean;
}

function createMountTaintClassifier(
  state: Record<string, unknown>,
): MountTaintClassifier {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  function sourceIsTainted(source: string): boolean {
    if (isProtectedConfigPath(source)) return true;
    const cached = memo.get(source);
    if (cached !== undefined) return cached;
    if (visiting.has(source)) return false;
    visiting.add(source);
    const target = safeDeepGet(state, source);
    const tainted = isConfigMount(target) && sourceIsTainted(target.source);
    visiting.delete(source);
    memo.set(source, tainted);
    return tainted;
  }

  return { isTainted: (mount) => sourceIsTainted(mount.source) };
}

function projectPublicEntries(
  entries: Record<string, unknown>,
  state: Record<string, unknown> = entries,
): Record<string, unknown> {
  return projectRecord(
    filterProtectedConfigEntries(entries),
    "",
    createMountTaintClassifier(state),
  );
}

function projectRecord(
  value: Record<string, unknown>,
  prefix: string,
  classifier: MountTaintClassifier,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const publicChild = projectValue(child, path, classifier);
    if (publicChild !== omitted) projected[key] = publicChild;
  }
  return projected;
}

function projectValue(
  value: unknown,
  path: string,
  classifier: MountTaintClassifier,
): unknown | typeof omitted {
  if (isConfigMount(value)) {
    return classifier.isTainted(value) ? omitted : value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => {
      const projected = projectValue(child, `${path}.${index}`, classifier);
      return projected === omitted ? undefined : projected;
    });
  }
  return isRecord(value) ? projectRecord(value, path, classifier) : value;
}

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
    Object.entries(scopes).map(([scope, entries]) => {
      const state = deepMerge(baseEntries, entries);
      return [
        scope,
        resolveEntries(
          projectPublicEntries(entries, state),
          projectPublicEntries(state),
        ),
      ];
    }),
  );
}

function projectPublicDelta(
  delta: ConfigDelta,
  state: Record<string, unknown>,
): ConfigDelta | null {
  if (isProtectedConfigPath(delta.key)) return null;
  if (delta.action === "remove") return delta;
  const value = projectValue(
    delta.value,
    delta.key,
    createMountTaintClassifier(state),
  );
  return { ...delta, value: value === omitted ? undefined : value };
}

export function inspectPublicConfig(
  key: string,
  layers: readonly ConfigInspectionLayer[],
): ConfigurationInspection<unknown> {
  if (isProtectedConfigPath(key)) return emptyInspection(key);

  let state: Record<string, unknown> = {};
  for (const layer of layers) state = deepMerge(state, layer.entries);
  const classifier = createMountTaintClassifier(state);
  const layerValues: Record<string, unknown> = {};
  let effectiveValue: unknown;
  let effectiveLayer: string | undefined;
  for (const layer of layers) {
    const entries = projectRecord(
      filterProtectedConfigEntries(layer.entries),
      "",
      classifier,
    );
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

function safeDeepGet(state: Record<string, unknown>, path: string): unknown {
  try {
    return deepGet(state, path);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
