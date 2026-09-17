import { buildPath, parsePath } from "@weaver-conf/config-engine";
import type { SecretReference } from "@weaver-conf/config-types";
import { isSecretReference } from "@weaver-conf/config-types";

/** Minimal interface for resolving secrets — decoupled from the full SecretResolutionService. */
export interface SecretBackend {
  resolve(ref: SecretReference): Promise<string | undefined>;
}

export interface SecretResolverOptions {
  backend: SecretBackend;
  refreshIntervalMs?: number;
  onRefreshError?: (error: unknown) => void;
}

export interface SecretResolver {
  /** Get pre-resolved plaintext for a key (sync). */
  getResolved(key: string): string | undefined;
  /** Check if a key has a secret. */
  hasSecret(key: string): boolean;
  /** Re-scan entries and resolve any new/changed secrets. */
  refresh(entries: Readonly<Record<string, unknown>>): Promise<void>;
  /** Stop background refresh timer. */
  dispose(): void;
}

/** Scan entries for SecretReference markers, return map of key -> SecretReference. */
function scanSecrets(
  entries: Readonly<Record<string, unknown>>,
): Map<string, SecretReference> {
  const refs = new Map<string, SecretReference>();
  const active = new WeakSet<object>();

  function scan(value: unknown, path: readonly string[]): void {
    if (isSecretReference(value)) {
      refs.set(buildPath(path), value);
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
  return refs;
}

// Timer primitives — declared to avoid dependency on Node/DOM lib types
declare function setInterval(handler: () => void, timeout: number): number;
declare function clearInterval(handle: number): void;

export async function createSecretResolver(
  initialEntries: Readonly<Record<string, unknown>>,
  options: SecretResolverOptions,
): Promise<SecretResolver> {
  const { backend, refreshIntervalMs = 0, onRefreshError } = options;
  const cache = new Map<string, string>();
  let refs = scanSecrets(initialEntries);
  let timer: number | null = null;

  async function resolveAll(
    secrets: Map<string, SecretReference>,
  ): Promise<void> {
    for (const [key, ref] of secrets) {
      try {
        const value = await backend.resolve(ref);
        if (value !== undefined) {
          cache.set(key, value);
        } else {
          cache.delete(key);
        }
      } catch {
        // Keep stale cache entry on error
      }
    }
  }

  // Initial resolution
  await resolveAll(refs);

  // Background refresh
  if (refreshIntervalMs > 0) {
    timer = setInterval(() => {
      resolveAll(refs).catch((err) => onRefreshError?.(err));
    }, refreshIntervalMs);
  }

  return {
    getResolved(key: string): string | undefined {
      return cache.get(buildPath(parsePath(key)));
    },

    hasSecret(key: string): boolean {
      return refs.has(buildPath(parsePath(key)));
    },

    async refresh(entries: Readonly<Record<string, unknown>>): Promise<void> {
      refs = scanSecrets(entries);
      // Remove cached entries for keys no longer in refs
      for (const key of cache.keys()) {
        if (!refs.has(key)) cache.delete(key);
      }
      await resolveAll(refs);
    },

    dispose(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
