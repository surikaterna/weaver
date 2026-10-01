import {
  createMountSourceClassifier,
  deepMerge,
  inspectResolvedPath,
  parsePath,
  projectConfigurationData,
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
  return createMountSourceClassifier(
    state,
    (segments) => segments[0] === "_weaver",
    false,
  );
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
  const mount = ownMount(value);
  if (mount && classifier.isTainted(mount)) return omitted;
  return projectConfigurationData(value, classifier, {
    decide: (child, policy) => {
      const nested = ownMount(child);
      return nested
        ? policy.isTainted(nested)
          ? "omit"
          : "retain"
        : "descend";
    },
    child: (policy) => policy,
    preserveUndefinedArraySlots: true,
    mutableContainers: true,
  });
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
  const ordered: ReturnType<typeof inspectionLayer>[] = [];
  for (let rank = 0; rank < layers.length; rank++) {
    defineOwnData(
      ordered,
      String(rank),
      inspectionLayer(ownData(layers, String(rank)), rank),
    );
  }
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
