import { deepRemove, deepSet } from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import { formatScopePath } from "@weaver-conf/config-types";
import type { WeaverTransport } from "./transport";
import type { ConfigDelta, ConfigSnapshot } from "./types";

/** How scopes are loaded: lazily on access, eagerly at boot, or hot-reloaded. */
export type ScopeLoadingMode = "lazy" | "eager" | "hot";

/** Options for creating a scope loader instance. */
export interface ScopeLoaderOptions {
  mode: ScopeLoadingMode;
  transport: WeaverTransport;
  initialSnapshot: ConfigSnapshot;
}

/** Manages scope-specific configuration state with lazy/eager loading strategies. */
export interface ScopeLoader {
  getScopeState(
    scopePath: ScopeInstance[],
  ): Record<string, unknown> | undefined;
  preloadScope(scopePath: ScopeInstance[]): Promise<void>;
  applyDelta(delta: ConfigDelta, scopePath?: ScopeInstance[]): void;
  loadedScopes(): string[];
}

function buildScopeKey(scopePath: ScopeInstance[]): string {
  return formatScopePath(scopePath);
}

/**
 * Creates a scope loader that manages per-scope config state.
 *
 * @param options - Loading mode, transport, and initial snapshot
 * @returns A ScopeLoader for accessing and preloading scope-specific config
 */
export function createScopeLoader(options: ScopeLoaderOptions): ScopeLoader {
  const { mode, transport, initialSnapshot } = options;
  const scopeStates = new Map<string, Record<string, unknown>>();
  const loaded = new Set<string>();

  if (mode === "eager" || mode === "hot") {
    for (const [scopeKey, state] of Object.entries(initialSnapshot.scopes)) {
      scopeStates.set(scopeKey, { ...state });
      loaded.add(scopeKey);
    }
  }

  return {
    getScopeState(
      scopePath: ScopeInstance[],
    ): Record<string, unknown> | undefined {
      const key = buildScopeKey(scopePath);
      return scopeStates.get(key);
    },

    async preloadScope(scopePath: ScopeInstance[]): Promise<void> {
      const key = buildScopeKey(scopePath);
      if (loaded.has(key)) return;
      const snapshot = await transport.resolveAll({ scopePath });
      const scopeData = snapshot.scopes[key];
      if (scopeData) {
        scopeStates.set(key, { ...scopeData });
      } else {
        scopeStates.set(key, {});
      }
      loaded.add(key);
    },

    applyDelta(delta: ConfigDelta, scopePath?: ScopeInstance[]): void {
      if (!scopePath) return;
      const key = buildScopeKey(scopePath);
      const state = scopeStates.get(key);
      if (!state) return;
      if (delta.action === "set") {
        deepSet(state, delta.key, delta.value);
      } else {
        deepRemove(state, delta.key);
      }
    },

    loadedScopes(): string[] {
      return [...loaded];
    },
  };
}
