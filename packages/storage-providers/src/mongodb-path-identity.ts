import { buildPath, parsePath } from "@weaver-conf/config-engine";

export function canonicalMongoPath(path: string): string {
  return buildPath(parsePath(path));
}

export function isSameMongoPathOrDescendant(
  candidate: readonly string[],
  target: readonly string[],
): boolean {
  if (candidate.length < target.length) return false;
  return target.every((segment, index) => candidate[index] === segment);
}

export function mongoPathCandidatePattern(path: string): string {
  const prefix = parsePath(path)
    .map((segment, index) => segmentPattern(segment, index === 0))
    .join("");
  return `^${prefix}(?:$|\\.|\\[)`;
}

function segmentPattern(segment: string, first: boolean): string {
  const escaped = escapeRegex(segment);
  const bracketed = `\\[${escaped}\\]`;
  if (segment.includes(".")) return bracketed;
  return first
    ? `(?:${escaped}|${bracketed})`
    : `(?:\\.${escaped}|${bracketed})`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
