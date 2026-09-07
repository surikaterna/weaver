// Bracket-aware path parsing for compound key identifiers

import { createWeaverError } from "@weaver-conf/config-types";

const DANGEROUS_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function assertSafePathSegment(segment: string): void {
  if (DANGEROUS_PATH_SEGMENTS.has(segment)) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Path segment "${segment}" is not allowed`,
    );
  }
}

/**
 * Parses a dot-delimited path with bracket notation into segments.
 * Brackets protect dots from being treated as separators.
 */
export function parsePath(path: string): readonly string[] {
  if (path.length === 0) {
    throw createWeaverError("VALIDATION_ERROR", "Path must not be empty");
  }

  const segments: string[] = [];
  let current = "";
  let inBracket = false;
  let i = 0;

  while (i < path.length) {
    const ch = path[i];

    if (inBracket) {
      if (ch === "[") {
        throw createWeaverError(
          "VALIDATION_ERROR",
          `Nested brackets at position ${String(i)} in "${path}"`,
        );
      }
      if (ch === "]") {
        if (current.length === 0) {
          throw createWeaverError(
            "VALIDATION_ERROR",
            `Empty brackets in "${path}"`,
          );
        }
        segments.push(current);
        current = "";
        inBracket = false;
        i++;
        // After ']': expect '.', '[', or end
        if (i < path.length) {
          if (path[i] === ".") {
            i++;
            if (i >= path.length) {
              throw createWeaverError(
                "VALIDATION_ERROR",
                `Trailing dot in "${path}"`,
              );
            }
          } else if (path[i] !== "[") {
            throw createWeaverError(
              "VALIDATION_ERROR",
              `Expected '.' or '[' after ']' at position ${String(i)} in "${path}"`,
            );
          }
        }
        continue;
      }
      current += ch;
      i++;
    } else {
      if (ch === "]") {
        throw createWeaverError(
          "VALIDATION_ERROR",
          `Unmatched ']' at position ${String(i)} in "${path}"`,
        );
      }
      if (ch === "[") {
        if (current.length > 0) {
          segments.push(current);
          current = "";
        }
        inBracket = true;
        i++;
        if (i < path.length && path[i] === "[") {
          throw createWeaverError(
            "VALIDATION_ERROR",
            `Nested brackets at position ${String(i)} in "${path}"`,
          );
        }
        continue;
      }
      if (ch === ".") {
        if (current.length === 0) {
          throw createWeaverError(
            "VALIDATION_ERROR",
            `Empty segment (leading or double dot) in "${path}"`,
          );
        }
        segments.push(current);
        current = "";
        i++;
        if (i >= path.length) {
          throw createWeaverError(
            "VALIDATION_ERROR",
            `Trailing dot in "${path}"`,
          );
        }
        continue;
      }
      current += ch;
      i++;
    }
  }

  if (inBracket) {
    throw createWeaverError("VALIDATION_ERROR", `Unmatched '[' in "${path}"`);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  if (segments.length === 0) {
    throw createWeaverError("VALIDATION_ERROR", `Path must not be empty`);
  }

  for (const segment of segments) assertSafePathSegment(segment);
  return segments;
}

/**
 * Reconstructs a canonical path from segments.
 * Segments containing dots are wrapped in brackets.
 */
export function buildPath(segments: readonly string[]): string {
  let result = "";

  for (const [i, seg] of segments.entries()) {
    assertSafePathSegment(seg);
    const compound = isCompoundSegment(seg);

    if (i === 0) {
      result = compound ? `[${seg}]` : seg;
    } else {
      if (compound) {
        result += `[${seg}]`;
      } else {
        result += `.${seg}`;
      }
    }
  }

  return result;
}

/**
 * Returns true if a segment contains dots (is a compound identifier).
 */
export function isCompoundSegment(segment: string): boolean {
  return segment.includes(".");
}

/**
 * Returns the number of segments in a path (bracket-aware).
 */
export function pathDepth(path: string): number {
  return parsePath(path).length;
}
