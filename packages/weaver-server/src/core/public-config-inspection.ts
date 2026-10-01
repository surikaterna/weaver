import {
  deepMerge,
  inspectResolvedPath,
  parsePath,
  resolutionLayerSchema,
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
  const safe = resolutionLayerSchema.parse({
    layer: "projection",
    providerId: "projection",
    rank: 0,
    entries: { view: entries, state },
  }).entries;
  const view = ownData(safe, "view");
  const full = ownData(safe, "state");
  if (!isRecord(view) || !isRecord(full))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid public projection data",
    );
  return projectRecord(
    filterProtectedConfigEntries(view),
    createMountTaintClassifier(full),
  );
}

function projectRecord(
  value: Record<string, unknown>,
  classifier: MountTaintClassifier,
): Record<string, unknown> {
  const projected = projectValue(value, classifier);
  if (!isRecord(projected))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid public record projection",
    );
  return projected;
}

function projectValue(
  value: unknown,
  classifier: MountTaintClassifier,
): unknown | typeof omitted {
  let result: unknown;
  const memo = new WeakMap<object, object>();
  const tasks: (() => void)[] = [];
  const schedule = (child: unknown, assign: (output: unknown) => void) =>
    pushTask(tasks, () => projectChild(child, assign, memo, tasks, classifier));
  schedule(value, (output) => {
    result = output;
  });
  while (tasks.length) tasks.pop()?.();
  return result;
}

function projectChild(
  value: unknown,
  assign: (output: unknown) => void,
  memo: WeakMap<object, object>,
  tasks: (() => void)[],
  classifier: MountTaintClassifier,
): void {
  const mount = ownMount(value);
  if (mount) {
    assign(classifier.isTainted(mount) ? omitted : value);
    return;
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    assign(value);
    return;
  }
  const existing = memo.get(value);
  if (existing) {
    assign(existing);
    return;
  }
  const result: object = Array.isArray(value) ? [] : {};
  memo.set(value, result);
  assign(result);
  if (Array.isArray(value))
    Object.defineProperty(result, "length", { value: value.length });
  for (const key of Object.keys(value).reverse()) {
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) continue;
    const child = ownData(value, key);
    pushTask(tasks, () =>
      projectChild(
        child,
        (output) => {
          if (output !== omitted || Array.isArray(value))
            defineOwnData(result, key, output === omitted ? undefined : output);
        },
        memo,
        tasks,
        classifier,
      ),
    );
  }
}

function pushTask(tasks: (() => void)[], task: () => void): void {
  defineOwnData(tasks, String(tasks.length), task);
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
  const safe = resolutionLayerSchema.parse({
    layer: "delta",
    providerId: "delta",
    rank: 0,
    entries: { value: delta.value },
  }).entries;
  const value = projectValue(
    ownData(safe, "value"),
    createMountTaintClassifier(state),
  );
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
