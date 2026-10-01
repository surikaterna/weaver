import { captureDomain, type DomainCapture } from "@weaver-conf/config-types";
import { copySnapshotData } from "./descriptor-copy";
import { isPlainObject, ownDataValue } from "./own-data";
import {
  denseSnapshotArray,
  finiteSnapshotNumber,
  literalSnapshotPath,
  nonemptySnapshotString,
  requestSnapshotPath,
  snapshotRecord,
} from "./snapshot-capture-data";

export interface ResolutionOrigin {
  readonly layer: string;
  readonly providerId: string;
  readonly rank: number;
}
export interface ResolutionLayer extends ResolutionOrigin {
  readonly entries: Readonly<Record<string, unknown>>;
  readonly trustedEmergency?: boolean | undefined;
  readonly merge?: unknown;
}
export interface ResolutionCeiling {
  readonly path: readonly string[];
  readonly maxRank: number;
}
export interface ResolutionSnapshotInput {
  readonly layers: readonly ResolutionLayer[];
  readonly configuredRanks: readonly number[];
  readonly ceilings: readonly ResolutionCeiling[];
}
export interface ResolutionContribution {
  readonly origin: ResolutionOrigin;
  readonly present: boolean;
  readonly value: unknown;
}
export interface ConfigurationSnapshot {
  readonly entries: Readonly<Record<string, unknown>>;
  readonly layers: readonly ResolutionLayer[];
}
export interface ResolvedPathInspection {
  readonly path: readonly string[];
  readonly present: boolean;
  readonly effectiveValue: unknown;
  readonly effectiveLayer?: string | undefined;
  readonly effectiveProviderId?: string | undefined;
  readonly contributions: readonly ResolutionContribution[];
}

export function captureSnapshotContract<T>(
  input: unknown,
  guard: (value: unknown) => value is T,
): DomainCapture<T> {
  return captureDomain(copySnapshotData(input), guard);
}

function originFields(value: Record<string, unknown>): boolean {
  return (
    nonemptySnapshotString(value.layer) &&
    nonemptySnapshotString(value.providerId) &&
    finiteSnapshotNumber(value.rank)
  );
}
export function isResolutionOrigin(value: unknown): value is ResolutionOrigin {
  return (
    snapshotRecord(value, ["layer", "providerId", "rank"]) &&
    originFields(value)
  );
}
export function isResolutionLayer(value: unknown): value is ResolutionLayer {
  return (
    snapshotRecord(
      value,
      ["layer", "providerId", "rank", "entries"],
      ["trustedEmergency", "merge"],
    ) &&
    originFields(value) &&
    isPlainObject(value.entries) &&
    (ownDataValue(value, "trustedEmergency") === undefined ||
      typeof ownDataValue(value, "trustedEmergency") === "boolean")
  );
}
export function isResolutionCeiling(
  value: unknown,
): value is ResolutionCeiling {
  return (
    snapshotRecord(value, ["path", "maxRank"]) &&
    requestSnapshotPath(value.path) &&
    finiteSnapshotNumber(value.maxRank)
  );
}
export function isResolutionSnapshotInput(
  value: unknown,
): value is ResolutionSnapshotInput {
  return (
    snapshotRecord(value, ["layers", "configuredRanks", "ceilings"]) &&
    denseSnapshotArray(value.layers, isResolutionLayer) &&
    denseSnapshotArray(value.configuredRanks, finiteSnapshotNumber) &&
    value.configuredRanks.length > 0 &&
    denseSnapshotArray(value.ceilings, isResolutionCeiling)
  );
}
export function isResolutionContribution(
  value: unknown,
): value is ResolutionContribution {
  return (
    snapshotRecord(value, ["origin", "present", "value"]) &&
    isResolutionOrigin(value.origin) &&
    typeof value.present === "boolean"
  );
}
export function isConfigurationSnapshot(
  value: unknown,
): value is ConfigurationSnapshot {
  return (
    snapshotRecord(value, ["entries", "layers"]) &&
    isPlainObject(value.entries) &&
    denseSnapshotArray(value.layers, isResolutionLayer)
  );
}
export function isResolvedPathInspection(
  value: unknown,
): value is ResolvedPathInspection {
  return (
    snapshotRecord(
      value,
      ["path", "present", "effectiveValue", "contributions"],
      ["effectiveLayer", "effectiveProviderId"],
    ) &&
    literalSnapshotPath(value.path) &&
    typeof value.present === "boolean" &&
    denseSnapshotArray(value.contributions, isResolutionContribution) &&
    optionalString(value, "effectiveLayer") &&
    optionalString(value, "effectiveProviderId")
  );
}
function optionalString(value: object, key: string): boolean {
  const data = ownDataValue(value, key);
  return data === undefined || typeof data === "string";
}
