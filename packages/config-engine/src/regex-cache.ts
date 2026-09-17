/**
 * Regex caching utility to avoid repeated compilation of the same patterns.
 * Also provides a safety check for user-supplied patterns to prevent ReDoS.
 */

import { createWeaverError, isSafePattern } from "@weaver-conf/config-types";

export { isSafePattern } from "@weaver-conf/config-types";

const regexCache = new Map<string, RegExp>();

/** Returns a cached RegExp instance for the given pattern and flags. */
export function getCachedRegex(pattern: string, flags?: string): RegExp {
  const key = `${pattern}\0${flags ?? ""}`;
  let cached = regexCache.get(key);
  if (!cached) {
    cached = new RegExp(pattern, flags);
    regexCache.set(key, cached);
  }
  return cached;
}

/** Schema matching must enforce the shared policy before executing a pattern. */
export function getSafeSchemaRegex(pattern: string): RegExp {
  if (!isSafePattern(pattern)) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Unsafe regex pattern ${JSON.stringify(pattern)}`,
    );
  }
  try {
    return getCachedRegex(pattern);
  } catch {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Invalid regex pattern ${JSON.stringify(pattern)}`,
    );
  }
}

/** Clears the regex cache (useful for testing). */
export function clearRegexCache(): void {
  regexCache.clear();
}
