import { resolveConfiguration } from "@weaver-conf/config-engine";
import {
  type ConfigurationLayerEntry,
  createWeaverError,
} from "@weaver-conf/config-types";

export function appendOrderedValue<T>(values: T[], value: T): void {
  Object.defineProperty(values, String(values.length), {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function ownOrderedEntry(
  entries: readonly Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
  if (!descriptor || !Object.hasOwn(descriptor, "value"))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Ordered resolution requires own dense entries",
    );
  const value: unknown = descriptor.value;
  if (!isEntry(value))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid ordered configuration entry",
    );
  return value;
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve adapter ordering/grouping while delegating every value decision to the engine. */
export function resolveOrderedEntries(
  entries: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const layers: ConfigurationLayerEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    appendOrderedValue(layers, {
      layer: "core",
      entries: ownOrderedEntry(entries, index),
    });
  }
  return resolveConfiguration({ layers }).entries;
}
