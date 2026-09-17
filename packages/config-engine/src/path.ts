// Bracket-aware path parsing for compound key identifiers

import {
  createWeaverError,
  isReservedPathSegment,
} from "@weaver-conf/config-types";

export function assertSafePathSegment(segment: string): void {
  if (isReservedPathSegment(segment)) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Path segment "${segment}" is not allowed`,
    );
  }
}

interface PathParserState {
  readonly path: string;
  readonly segments: string[];
  current: string;
  index: number;
  inBracket: boolean;
}

/**
 * Parses a dot-delimited path with bracket notation into segments.
 * Brackets protect dots from being treated as separators.
 */
export function parsePath(path: string): readonly string[] {
  if (path.length === 0) {
    throw createWeaverError("VALIDATION_ERROR", "Path must not be empty");
  }

  const state = createParserState(path);
  while (state.index < path.length) parseNextCharacter(state);
  const segments = finishPath(state);
  for (const segment of segments) assertSafePathSegment(segment);
  return segments;
}

function createParserState(path: string): PathParserState {
  return { path, segments: [], current: "", index: 0, inBracket: false };
}

function parseNextCharacter(state: PathParserState): void {
  if (state.inBracket) parseBracketCharacter(state);
  else parsePlainCharacter(state);
}

function parseBracketCharacter(state: PathParserState): void {
  const character = state.path[state.index];
  if (character === "[") {
    invalidAt(state, "Nested brackets");
  }
  if (character === "]") {
    closeBracket(state);
    return;
  }
  state.current += character;
  state.index++;
}

function closeBracket(state: PathParserState): void {
  if (state.current.length === 0) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Empty brackets in "${state.path}"`,
    );
  }
  pushCurrentSegment(state);
  state.inBracket = false;
  state.index++;
  consumePostBracketSeparator(state);
}

function consumePostBracketSeparator(state: PathParserState): void {
  if (state.index >= state.path.length) return;
  const character = state.path[state.index];
  if (character === "[") return;
  if (character !== ".") {
    invalidAt(state, "Expected '.' or '[' after ']'");
  }
  state.index++;
  assertNotTrailingDot(state);
}

function parsePlainCharacter(state: PathParserState): void {
  const character = state.path[state.index];
  if (character === "]") invalidAt(state, "Unmatched ']'");
  if (character === "[") {
    openBracket(state);
    return;
  }
  if (character === ".") {
    closePlainSegment(state);
    return;
  }
  state.current += character;
  state.index++;
}

function openBracket(state: PathParserState): void {
  if (state.current.length > 0) pushCurrentSegment(state);
  state.inBracket = true;
  state.index++;
  if (state.path[state.index] === "[") invalidAt(state, "Nested brackets");
}

function closePlainSegment(state: PathParserState): void {
  if (state.current.length === 0) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Empty segment (leading or double dot) in "${state.path}"`,
    );
  }
  pushCurrentSegment(state);
  state.index++;
  assertNotTrailingDot(state);
}

function pushCurrentSegment(state: PathParserState): void {
  state.segments.push(state.current);
  state.current = "";
}

function assertNotTrailingDot(state: PathParserState): void {
  if (state.index >= state.path.length) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Trailing dot in "${state.path}"`,
    );
  }
}

function finishPath(state: PathParserState): readonly string[] {
  if (state.inBracket) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Unmatched '[' in "${state.path}"`,
    );
  }
  if (state.current.length > 0) pushCurrentSegment(state);
  if (state.segments.length === 0) {
    throw createWeaverError("VALIDATION_ERROR", "Path must not be empty");
  }
  return state.segments;
}

function invalidAt(state: PathParserState, reason: string): never {
  throw createWeaverError(
    "VALIDATION_ERROR",
    `${reason} at position ${String(state.index)} in "${state.path}"`,
  );
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
