import { resolveConfiguration } from "@weaver-conf/config-engine";

/** Preserve adapter ordering/grouping while delegating every value decision to the engine. */
export function resolveOrderedEntries(
  entries: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return resolveConfiguration({
    layers: entries.map((value) => ({ layer: "core", entries: value })),
  }).entries;
}
