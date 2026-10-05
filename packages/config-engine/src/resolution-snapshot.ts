import { createWeaverError } from "@weaver-conf/config-types";
import { freezeSnapshotData } from "./descriptor-copy";
import { mergeObservedRecords } from "./merge-traversal";
import { isPlainObject, ownDataValue } from "./own-data";
import { assertSafePathSegment } from "./path";
import {
  observeOriginGraph,
  observeResolution,
} from "./resolution-observation";
import type { OriginNode, RecordOrigin } from "./resolution-origins";
import { compileResolutionPolicy } from "./resolution-policy";
import {
  type ConfigurationSnapshot,
  type ResolutionLayer,
  type ResolutionOrigin,
  type ResolutionSnapshotInput,
  type ResolvedPathInspection,
  resolutionPathSchema,
  resolutionSnapshotInputSchema,
} from "./snapshot-contracts";

const issuedSnapshots = new WeakMap<object, RecordOrigin>();

function originOf(layer: ResolutionLayer): ResolutionOrigin {
  return Object.freeze({
    layer: layer.layer,
    providerId: layer.providerId,
    rank: layer.rank,
  });
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

/** Data DTOs serialize; exact issued object identity is the inspection handle. */
export function resolveConfigurationSnapshot(
  input: ResolutionSnapshotInput,
): ConfigurationSnapshot {
  const parsed = resolutionSnapshotInputSchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid resolution snapshot input",
    );
  validatePlan(parsed.data);
  const policy = compileResolutionPolicy(parsed.data.ceilings);
  const emergency = compileResolutionPolicy([]);
  let entries: Record<string, unknown> = {};
  let origin: RecordOrigin | undefined;
  for (const layer of parsed.data.layers) {
    if (Object.keys(layer.entries).length === 0) continue;
    const merged = mergeObservedRecords(entries, layer.entries, origin, {
      origin: originOf(layer),
      rank: layer.rank,
      policy: layer.trustedEmergency ? emergency : policy,
    });
    entries = merged.entries;
    origin = merged.origin;
  }
  const snapshot = freezeSnapshotData({ entries, layers: parsed.data.layers });
  const root = origin ?? emptyOrigin();
  issuedSnapshots.set(snapshot, root);
  observeOriginGraph(root);
  return snapshot;
}

function emptyOrigin(): RecordOrigin {
  return Object.freeze({
    kind: "record",
    children: new Map(),
    summary: "empty",
  });
}

function lookup(
  entries: unknown,
  path: readonly string[],
  origin?: OriginNode,
) {
  let value = entries;
  let current = origin;
  for (const segment of path) {
    observeResolution("inspectSteps");
    if (
      (!isPlainObject(value) && !Array.isArray(value)) ||
      !Object.hasOwn(value, segment)
    )
      return { present: false, value: undefined, origin: undefined };
    value = ownDataValue(value, segment);
    if (current?.kind === "record") current = current.children.get(segment);
  }
  return { present: true, value, origin: current };
}

export function inspectResolvedPath(
  snapshot: ConfigurationSnapshot,
  path: readonly string[],
): ResolvedPathInspection {
  const root = issuedSnapshots.get(snapshot);
  if (!root)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Inspection requires an engine-issued snapshot handle",
    );
  const parsed = resolutionPathSchema.safeParse(path);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid resolution path");
  for (const segment of parsed.data) assertSafePathSegment(segment);
  const effective = lookup(snapshot.entries, parsed.data, root);
  const summary = effective.origin?.summary;
  const winner =
    effective.present && typeof summary === "object" ? summary : undefined;
  const contributions = snapshot.layers.map((layer) => {
    const raw = lookup(layer.entries, parsed.data);
    return Object.freeze({
      origin: originOf(layer),
      present: raw.present,
      value: raw.value,
    });
  });
  return Object.freeze({
    path: parsed.data,
    present: effective.present,
    effectiveValue: effective.value,
    effectiveLayer: winner?.layer,
    effectiveProviderId: winner?.providerId,
    contributions: Object.freeze(contributions),
  });
}
