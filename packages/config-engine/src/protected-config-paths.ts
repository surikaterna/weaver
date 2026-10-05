import { parsePath } from "./path";

export function isProtectedConfigPath(key: string): boolean {
  if (getLexicalFirstRoot(key) === "_weaver") return true;
  return getFirstLogicalPathSegment(key) === "_weaver";
}

function getFirstLogicalPathSegment(key: string): string | null {
  const normalized = key.startsWith("/") ? key.slice(1) : key;
  const path = normalized.replaceAll("/", ".");
  try {
    return parsePath(path)[0] ?? null;
  } catch {
    return null;
  }
}

function getLexicalFirstRoot(key: string): string {
  const normalized = key.startsWith("/") ? key.slice(1) : key;
  if (normalized.startsWith("[")) {
    const closingBracket = normalized.indexOf("]");
    return closingBracket < 0
      ? normalized.slice(1)
      : normalized.slice(1, closingBracket);
  }
  const delimiter = normalized.search(/[./[\]]/u);
  return delimiter < 0 ? normalized : normalized.slice(0, delimiter);
}
