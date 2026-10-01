// Namespace utilities for configuration key management

import { buildPath, parsePath } from "./path";

/**
 * Combines a namespace and a relative key with a dot separator.
 * e.g., qualifyKey("app.vesselView", "map.defaultZoom") → "app.vesselView.map.defaultZoom"
 */
export function qualifyKey(namespace: string, relativeKey: string): string {
  return `${namespace}.${relativeKey}`;
}

/**
 * Converts a kebab-case segment to camelCase.
 * "vessel-view" → "vesselView"
 */
function kebabToCamel(segment: string): string {
  return segment.replace(/-([a-zA-Z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

/**
 * Derives a configuration namespace from a plugin ID.
 *
 * - "myScope.vessel-view" → "myScope.vesselView" (kebab segments to camelCase)
 * - "@weaver-conf/vessel-view-plugin" → "weaver.vesselView" (scoped package name)
 * - Already in namespace format → pass-through
 */
export function deriveNamespace(pluginId: string): string {
  // Scoped package name: @weaver-conf/vessel-view-plugin → weaverConf.vesselView
  if (pluginId.startsWith("@")) {
    const withoutAt = pluginId.slice(1);
    const slashIndex = withoutAt.indexOf("/");
    if (slashIndex === -1) {
      return kebabToCamel(withoutAt);
    }
    const scope = withoutAt.slice(0, slashIndex);
    let name = withoutAt.slice(slashIndex + 1);
    // Strip -plugin suffix
    if (name.endsWith("-plugin")) {
      name = name.slice(0, -7);
    }
    return `${kebabToCamel(scope)}.${kebabToCamel(name)}`;
  }

  // Dotted plugin ID: myScope.vessel-view → myScope.vesselView
  const segments = pluginId.split(".");
  return segments.map((s) => kebabToCamel(s)).join(".");
}

const SEGMENT_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * Validates a fully-qualified configuration key format.
 * Must have at least 1 segment (bracket-aware), each plain segment alphanumeric.
 * Compound segments (from brackets) must have dot-separated sub-segments that are each valid.
 */
export function validateKeyFormat(key: string): {
  valid: boolean;
  error?: string;
} {
  let segments: readonly string[];
  try {
    segments = parsePath(key);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }

  if (segments.length === 0) {
    return { valid: false, error: `Key "${key}" must have at least 1 segment` };
  }

  for (const segment of segments) {
    const subSegments = segment.includes(".") ? segment.split(".") : [segment];
    for (const sub of subSegments) {
      if (sub.length === 0) {
        return {
          valid: false,
          error: `Key "${key}" contains an empty segment`,
        };
      }
      if (!SEGMENT_PATTERN.test(sub)) {
        return {
          valid: false,
          error: `Key "${key}" segment "${sub}" must start with a letter and contain only alphanumeric characters`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Extracts the namespace (first two segments) from a fully-qualified key.
 * "app.vesselView.map.zoom" → "app.vesselView"
 * "app.plugins[example.settings.panel].retentionDays" → "app.plugins"
 */
export function extractNamespace(fullyQualifiedKey: string): string {
  const segments = parsePath(fullyQualifiedKey);
  return buildPath(segments.slice(0, 2));
}
