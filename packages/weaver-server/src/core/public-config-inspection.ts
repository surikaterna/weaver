import {
  deepMerge,
  inspectResolvedPath,
  parsePath,
  resolveConfigurationSnapshot,
} from "@weaver-conf/config-engine";
import type {
  ConfigDelta,
  ConfigMount,
  ConfigurationInspection,
} from "@weaver-conf/config-types";
import { createWeaverError } from "@weaver-conf/config-types";
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
      const mount = ownMount(target);
      if (!mount) break;
      current = mount.source;
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
    createMountTaintClassifier(state),
  );
}

function projectRecord(
  value: Record<string, unknown>,
  classifier: MountTaintClassifier,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const publicChild = projectValue(ownData(value, key), classifier);
    if (publicChild !== omitted) defineOwnData(projected, key, publicChild);
  }
  return projected;
}

function projectValue(
  value: unknown,
  classifier: MountTaintClassifier,
): unknown | typeof omitted {
  const mount = ownMount(value);
  if (mount) {
    return classifier.isTainted(mount) ? omitted : value;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    Object.defineProperty(result, "length", { value: value.length });
    for (let index = 0; index < value.length; index++) {
      const key = String(index);
      if (!Object.hasOwn(value, key)) continue;
      const projected = projectValue(ownData(value, key), classifier);
      defineOwnData(result, key, projected === omitted ? undefined : projected);
    }
    return result;
  }
  return isRecord(value) ? projectRecord(value, classifier) : value;
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
  const value = projectValue(delta.value, createMountTaintClassifier(state));
  return { ...delta, value: value === omitted ? undefined : value };
}

export function inspectPublicConfig(
  key: string,
  layers: readonly ConfigInspectionLayer[],
): ConfigurationInspection<unknown> {
  if (isProtectedConfigPath(key)) return emptyInspection(key);

  const snapshot = resolutionSnapshot(layers);
  const state = snapshot.entries;
  const classifier = createMountTaintClassifier(state);
  const layerValues: Record<string, unknown> = {};
  for (const layer of snapshot.layers) {
    const entries = projectRecord(
      filterProtectedConfigEntries(layer.entries),
      classifier,
    );
    const value = safeDeepGet(entries, key);
    if (value === undefined) continue;
    defineOwnData(layerValues, layer.layer, value);
  }
  const inspection = inspectResolvedPath(snapshot, parsePath(key).map(String));
  const effectiveValue = safeDeepGet(
    projectPublicEntries(snapshot.entries, state),
    key,
  );
  return {
    key,
    effectiveValue,
    effectiveLayer:
      effectiveValue === undefined ? undefined : inspection.effectiveLayer,
    layerValues,
  };
}

function resolutionSnapshot(layers: readonly ConfigInspectionLayer[]) {
  const ordered = Array.from({ length: layers.length }, (_, rank) =>
    inspectionLayer(ownData(layers, String(rank)), rank),
  );
  return resolveConfigurationSnapshot({
    configuredRanks: ordered.length ? ordered.map((_, rank) => rank) : [0],
    ceilings: [],
    layers: ordered,
  });
}

function inspectionLayer(value: unknown, rank: number) {
  if (!isRecord(value))
    throw createWeaverError("VALIDATION_ERROR", "Invalid inspection layer");
  const layer = ownData(value, "layer");
  const entries = ownData(value, "entries");
  if (typeof layer !== "string" || !isRecord(entries))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid inspection layer data",
    );
  return { layer, entries, rank, providerId: `inspection:${rank}` };
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
    let value: unknown = state;
    for (const segment of parsePath(path)) {
      if (value === null || typeof value !== "object") return undefined;
      value = ownData(value, segment);
    }
    return value;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defineOwnData(target: object, key: string, value: unknown): void {
  Reflect.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value"))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Accessors are not public configuration data",
    );
  const data: unknown = descriptor.value;
  return data;
}

function ownMount(value: unknown): ConfigMount | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (ownData(value, "_weaver") !== "mount") return undefined;
  const source = ownData(value, "source");
  return typeof source === "string" ? { _weaver: "mount", source } : undefined;
}
