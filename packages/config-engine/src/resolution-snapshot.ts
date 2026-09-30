import { createWeaverError } from "@weaver-conf/config-types";
import { copySnapshotData, freezeSnapshotData } from "./descriptor-copy";
import {
  isPlainObject,
  type MergeObserver,
  mergeRecords,
} from "./merge-traversal";
import { ownDataValue } from "./own-data";
import { assertSafePathSegment } from "./path";
import {
  type ConfigurationSnapshot,
  configurationSnapshotSchema,
  type ResolutionCeiling,
  type ResolutionLayer,
  type ResolutionOrigin,
  type ResolutionSnapshotInput,
  type ResolutionTrace,
  type ResolvedPathInspection,
  resolutionPathSchema,
  resolutionSnapshotInputSchema,
} from "./snapshot-contracts";

const issuedSnapshots = new WeakSet<object>();

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((part, index) => part === path[index])
  );
}

function originOf(layer: ResolutionLayer): ResolutionOrigin {
  return { layer: layer.layer, providerId: layer.providerId, rank: layer.rank };
}

function validatePlan(input: ResolutionSnapshotInput): void {
  const pairs = new Set<string>();
  for (const layer of input.layers) {
    if (layer.merge !== undefined)
      throw createWeaverError(
        "UNSUPPORTED_OPERATION",
        "Opaque custom merge cannot provide provenance",
      );
    const pair = JSON.stringify([layer.layer, layer.providerId]);
    if (pairs.has(pair))
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Duplicate resolution layer/provider",
      );
    pairs.add(pair);
    if (!input.configuredRanks.includes(layer.rank))
      throw createWeaverError("VALIDATION_ERROR", "Unknown layer rank");
  }
  for (const ceiling of input.ceilings) {
    if (!input.configuredRanks.includes(ceiling.maxRank))
      throw createWeaverError("VALIDATION_ERROR", "Unknown ceiling rank");
  }
}

function allowed(
  path: readonly string[],
  value: unknown,
  layer: ResolutionLayer,
  ceilings: readonly ResolutionCeiling[],
  base: unknown,
): boolean {
  if (layer.trustedEmergency === true) return true;
  return !ceilings.some(
    (ceiling) =>
      layer.rank > ceiling.maxRank &&
      (isPrefix(ceiling.path, path) ||
        ((!isPlainObject(value) || Array.isArray(base)) &&
          isPrefix(path, ceiling.path))),
  );
}

function observerFor(
  layer: ResolutionLayer,
  ceilings: readonly ResolutionCeiling[],
  trace: Map<string, ResolutionTrace>,
): MergeObserver {
  const origin = originOf(layer);
  return {
    allow: (path, value, base) => allowed(path, value, layer, ceilings, base),
    replace: (path, value) => {
      for (const [key, record] of trace) {
        if (isPrefix(path, record.path) || isPrefix(record.path, path))
          trace.delete(key);
      }
      if (!isPlainObject(value))
        trace.set(JSON.stringify(path), { path, origin });
    },
    empty: (path) => {
      const key = JSON.stringify(path);
      trace.set(key, { path, origin });
    },
  };
}

/** Resolves detached plain data once; inspection never reruns a merge or provider. */
export function resolveConfigurationSnapshot(
  input: ResolutionSnapshotInput,
): ConfigurationSnapshot {
  const parsed = resolutionSnapshotInputSchema.safeParse(
    copySnapshotData(input),
  );
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid resolution snapshot input",
    );
  validatePlan(parsed.data);
  const trace = new Map<string, ResolutionTrace>();
  let entries: Record<string, unknown> = {};
  for (const layer of parsed.data.layers) {
    if (Object.keys(layer.entries).length === 0) continue;
    entries = mergeRecords(
      entries,
      layer.entries,
      observerFor(layer, parsed.data.ceilings, trace),
    );
  }
  const snapshot = freezeSnapshotData({
    entries,
    layers: parsed.data.layers,
    trace: [...trace.values()],
  });
  issuedSnapshots.add(snapshot);
  return snapshot;
}

function lookup(
  entries: unknown,
  path: readonly string[],
): { present: boolean; value: unknown } {
  let value = entries;
  for (const segment of path) {
    if (
      (!isPlainObject(value) && !Array.isArray(value)) ||
      !Object.hasOwn(value, segment)
    ) {
      return { present: false, value: undefined };
    }
    value = ownDataValue(value, segment);
  }
  return { present: true, value };
}

function winningOrigin(
  snapshot: ConfigurationSnapshot,
  path: readonly string[],
): ResolutionOrigin | undefined {
  const records = snapshot.trace.filter(
    (record) => isPrefix(path, record.path) || isPrefix(record.path, path),
  );
  const first = records[0]?.origin;
  if (!first) return undefined;
  return records.every(
    ({ origin }) =>
      origin.layer === first.layer && origin.providerId === first.providerId,
  )
    ? first
    : undefined;
}

export function inspectResolvedPath(
  snapshot: ConfigurationSnapshot,
  path: readonly string[],
): ResolvedPathInspection {
  const parsed = resolutionPathSchema.safeParse(copySnapshotData(path));
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid resolution path");
  for (const segment of parsed.data) assertSafePathSegment(segment);
  const safeSnapshot = validatedSnapshot(snapshot);
  const effective = lookup(safeSnapshot.entries, parsed.data);
  const origin = effective.present
    ? winningOrigin(safeSnapshot, parsed.data)
    : undefined;
  const contributions = safeSnapshot.layers.map((layer) => ({
    origin: originOf(layer),
    ...lookup(layer.entries, parsed.data),
  }));
  return freezeSnapshotData({
    path: parsed.data,
    present: effective.present,
    effectiveValue: effective.value,
    effectiveLayer: origin?.layer,
    effectiveProviderId: origin?.providerId,
    contributions,
  });
}

function validatedSnapshot(
  snapshot: ConfigurationSnapshot,
): ConfigurationSnapshot {
  if (issuedSnapshots.has(snapshot)) return snapshot;
  const parsed = configurationSnapshotSchema.safeParse(snapshot);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid resolution snapshot");
  return freezeSnapshotData(parsed.data);
}
