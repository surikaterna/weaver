import {
  createWeaverError,
  hasDomainFields,
  isReservedPathSegment,
} from "@weaver-conf/config-types";
import { isPlainObject, ownDataValue } from "./own-data";

export function snapshotRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return isPlainObject(value) && hasDomainFields(value, required, optional);
}

export function denseSnapshotArray<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): value is readonly T[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, String(index)))
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Sparse structural arrays are not resolution metadata",
      );
    if (!guard(ownDataValue(value, String(index)))) return false;
  }
  return true;
}

export function literalSnapshotPath(
  value: unknown,
): value is readonly string[] {
  return denseSnapshotArray(
    value,
    (segment): segment is string => typeof segment === "string",
  );
}
export function requestSnapshotPath(
  value: unknown,
): value is readonly string[] {
  return denseSnapshotArray(
    value,
    (segment): segment is string =>
      typeof segment === "string" && !isReservedPathSegment(segment),
  );
}
export function finiteSnapshotNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function nonemptySnapshotString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
