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

  function sourceIsTainted(source: string): boolean {
    const visited: string[] = [];
    const local = new Set<string>();
    let current = source;
    let terminal = false;
    while (true) {
      if (isProtectedConfigPath(current)) {
        terminal = true;
        break;
      }
      const cached = memo.get(current);
      if (cached !== undefined) {
        terminal = cached;
        break;
      }
      if (local.has(current)) break;
      local.add(current);
      visited.push(current);
      const target = safeDeepGet(state, current);
      if (!isConfigMount(target)) break;
      current = target.source;
    }
    for (const path of visited) memo.set(path, terminal);
    return terminal;
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
    if (publicChild !== omitted) defineOwnData(projected, key, publicChild);
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
    defineOwnData(layerValues, layer.layer, value);
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

function defineOwnData(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Reflect.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
