// Deep merge utility for configuration layer resolution

import { mergeRecords } from "./merge-traversal";

/**
 * Deep merges two configuration objects.
 *
 * Rules:
 * - Objects: recursively deep merge
 * - Arrays: override replaces base (no concatenation)
 * - Primitives: override replaces base
 * - null in override: clears the value (returns null, blocking lower layers)
 * - undefined in override: skipped (does not override base)
 * - Non-plain objects (Date, RegExp, etc.): replace, don't merge
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  return mergeRecords(base, override);
}
