import { buildPath, parsePath } from "@weaver-conf/config-engine";
import { isConfigMount } from "@weaver-conf/config-types";

export interface MountResolution {
  value: unknown;
  chain: string[];
}

export interface MountError {
  type: "cycle" | "max-depth";
  chain: string[];
}

export type MountResult =
  | { ok: true; resolution: MountResolution }
  | { ok: false; error: MountError };

/** Scan entries for ConfigMount markers, return a map of key -> source key. */
export function buildMountMap(
  entries: Record<string, unknown>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const active = new WeakSet<object>();

  function scan(value: unknown, path: readonly string[]): void {
    if (isConfigMount(value)) {
      map.set(buildPath(path), buildPath(parsePath(value.source)));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (active.has(value)) return;
    active.add(value);
    try {
      for (const [key, item] of Object.entries(value)) {
        scan(item, [...path, key]);
      }
    } finally {
      active.delete(value);
    }
  }

  scan(entries, []);
  return map;
}

/** Resolve a key through mount chain. Returns the final value or an error. */
export function resolveMountedValue(
  key: string,
  mountMap: ReadonlyMap<string, string>,
  getValue: (key: string) => unknown,
  maxDepth = 3,
): MountResult {
  const canonicalKey = buildPath(parsePath(key));
  const chain: string[] = [canonicalKey];
  let current = canonicalKey;

  for (let depth = 0; depth < maxDepth; depth++) {
    const source = mountMap.get(current);
    if (!source) {
      return { ok: true, resolution: { value: getValue(current), chain } };
    }
    if (chain.includes(source)) {
      return { ok: false, error: { type: "cycle", chain: [...chain, source] } };
    }
    chain.push(source);
    current = source;
  }

  // After loop exhaustion, check if current is a terminal
  if (!mountMap.has(current)) {
    return { ok: true, resolution: { value: getValue(current), chain } };
  }

  return { ok: false, error: { type: "max-depth", chain } };
}

/** Resolve all keys in a namespace, following mounts. */
export function resolveMountedNamespace(
  prefix: string,
  mountMap: ReadonlyMap<string, string>,
  getNamespace: (prefix: string) => Record<string, unknown>,
  getValue: (key: string) => unknown,
  maxDepth = 3,
): Record<string, unknown> {
  const entries = getNamespace(prefix);
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(entries)) {
    const fullKey = buildPath([...(prefix ? parsePath(prefix) : []), k]);
    if (isConfigMount(v)) {
      const resolved = resolveMountedValue(
        fullKey,
        mountMap,
        getValue,
        maxDepth,
      );
      result[k] = resolved.ok ? resolved.resolution.value : undefined;
    } else {
      result[k] = v;
    }
  }

  return result;
}
