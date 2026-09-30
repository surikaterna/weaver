export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export interface MergeObserver {
  allow(path: readonly string[], value: unknown, base: unknown): boolean;
  replace(path: readonly string[], value: unknown): void;
  empty(path: readonly string[]): void;
}

// Both legacy values and governed traces use these exact operation decisions.
export function mergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  observer?: MergeObserver,
  path: readonly string[] = [],
  insertion = false,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(base)) result[key] = base[key];
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value === undefined && !insertion) continue;
    const childPath = [...path, key];
    if (observer && !observer.allow(childPath, value, result[key])) continue;
    if (value === null) {
      observer?.replace(childPath, value);
      result[key] = null;
      continue;
    }
    result[key] = mergeValue(result[key], value, observer, childPath);
  }
  if (
    observer &&
    Object.keys(result).length === 0 &&
    (insertion || Object.keys(override).length === 0)
  )
    observer.empty(path);
  return result;
}

function mergeValue(
  base: unknown,
  value: unknown,
  observer: MergeObserver | undefined,
  path: readonly string[],
): unknown {
  if (value !== null && isPlainObject(base) && isPlainObject(value)) {
    return mergeRecords(base, value, observer, path);
  }
  observer?.replace(path, value);
  if (observer && isPlainObject(value)) {
    return mergeRecords({}, value, observer, path, true);
  }
  return value;
}
