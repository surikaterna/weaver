import { deepGet, deepRemove, deepSet } from "@weaver-conf/config-engine";
import type { ScopeDefinition, ScopeInstance } from "@weaver-conf/config-types";
import { formatScopePath } from "@weaver-conf/config-types";
import type { WeaverTransport, WriteOptions, WriteResult } from "./transport";
import type {
  ConfigDelta,
  ConfigSnapshot,
  GetOptions,
  ResolveOptions,
  Unsubscribe,
} from "./types";

export interface LocalTransportOptions {
  snapshot: ConfigSnapshot;
  latencyMs?: number;
}

export interface LocalTransport extends WeaverTransport {
  pushDelta(delta: ConfigDelta): void;
}

function buildScopeKey(scopePath: ScopeInstance[]): string {
  return formatScopePath(scopePath);
}

/**
 * Creates an in-memory transport backed by a static snapshot.
 * Useful for testing, offline-first scenarios, and local development.
 *
 * @param options - Snapshot data and optional simulated latency
 * @returns A LocalTransport that can also push synthetic deltas
 */
export function createLocalTransport(
  options: LocalTransportOptions,
): LocalTransport {
  const { snapshot, latencyMs } = options;
  const subscribers = new Set<(delta: ConfigDelta) => void>();

  async function withLatency<T>(value: T): Promise<T> {
    if (latencyMs && latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }
    return value;
  }

  return {
    writeAuthority: "local",
    async resolveAll(_opts?: ResolveOptions): Promise<ConfigSnapshot> {
      return withLatency(snapshot);
    },

    async get(key: string, opts?: GetOptions): Promise<unknown> {
      const source = opts?.scopePath?.length
        ? (snapshot.scopes[buildScopeKey(opts.scopePath)] ?? {})
        : snapshot.entries;
      // SAFETY: source is Record<string, unknown> from snapshot structure
      return withLatency(deepGet(source, key));
    },

    async getNamespace(
      prefix: string,
      opts?: GetOptions,
    ): Promise<Record<string, unknown>> {
      const source = opts?.scopePath?.length
        ? (snapshot.scopes[buildScopeKey(opts.scopePath)] ?? {})
        : snapshot.entries;
      // SAFETY: source is Record<string, unknown> from snapshot structure
      const value = deepGet(source, prefix);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return withLatency(value as Record<string, unknown>); // SAFETY: guarded by typeof/null/array checks
      }
      return withLatency({});
    },

    subscribe(handler: (delta: ConfigDelta) => void): Unsubscribe {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    async inspect(key: string): Promise<unknown> {
      // SAFETY: snapshot.entries is Record<string, unknown>
      const value = deepGet(snapshot.entries, key);
      return withLatency({ key, value, source: "local" });
    },

    async set(
      key: string,
      value: unknown,
      _options?: WriteOptions,
    ): Promise<WriteResult> {
      deepSet(snapshot.entries, key, value);
      return withLatency({ success: true, revision: `local-${Date.now()}` });
    },

    async remove(key: string, _options?: WriteOptions): Promise<WriteResult> {
      // SAFETY: snapshot.entries is Record<string, unknown>
      deepRemove(snapshot.entries, key);
      return withLatency({ success: true, revision: `local-${Date.now()}` });
    },

    async setMany(
      entries: Record<string, unknown>,
      _options?: WriteOptions,
    ): Promise<WriteResult> {
      for (const [key, value] of Object.entries(entries)) {
        // SAFETY: snapshot.entries is Record<string, unknown>
        deepSet(snapshot.entries, key, value);
      }
      return withLatency({ success: true, revision: `local-${Date.now()}` });
    },

    async listScopes(): Promise<ScopeDefinition[]> {
      const scopeIds = new Set<string>();
      for (const scopePathStr of Object.keys(snapshot.scopes ?? {})) {
        const parts = scopePathStr.split("/");
        for (const part of parts) {
          const colonIdx = part.indexOf(":");
          if (colonIdx !== -1) scopeIds.add(part.slice(0, colonIdx));
        }
      }
      return withLatency([...scopeIds].map((id) => ({ id, label: id })));
    },

    async listScopeValues(
      scopeId: string,
      _parentScope?: ScopeInstance[],
    ): Promise<string[]> {
      const values = new Set<string>();
      for (const scopePathStr of Object.keys(snapshot.scopes ?? {})) {
        const parts = scopePathStr.split("/");
        for (const part of parts) {
          const colonIdx = part.indexOf(":");
          if (colonIdx !== -1 && part.slice(0, colonIdx) === scopeId) {
            values.add(part.slice(colonIdx + 1));
          }
        }
      }
      return withLatency([...values]);
    },

    async close(): Promise<void> {
      subscribers.clear();
    },

    pushDelta(delta: ConfigDelta): void {
      for (const handler of subscribers) {
        handler(delta);
      }
    },
  };
}
