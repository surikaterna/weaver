import { deepRemove, deepSet } from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import { matchGlob } from "./client-helpers";
import type { ClientSchemaRegistry } from "./schema-registry";
import type { StalenessMonitor } from "./staleness";
import type { WeaverTransport } from "./transport";
import type { ConfigDelta, Unsubscribe } from "./types";

export interface SubscriptionDeps {
  baseState: Record<string, unknown>;
  transport: WeaverTransport;
  registry: ClientSchemaRegistry | undefined;
  changeListeners: Map<string, Set<(changes: ConfigDelta[]) => void>>;
  restartListeners: Set<() => void>;
  stalenessMonitor: StalenessMonitor;
  onSync: (date: Date) => void;
  onRestartRequired: () => void;
  applyScopedDelta: (delta: ConfigDelta, scopePath: ScopeInstance[]) => void;
}

export function setupDeltaSubscription(deps: SubscriptionDeps): Unsubscribe {
  const {
    baseState,
    transport,
    registry,
    changeListeners,
    restartListeners,
    stalenessMonitor,
    onSync,
    onRestartRequired,
    applyScopedDelta,
  } = deps;

  let pendingRestart = false;

  return transport.subscribe((delta: ConfigDelta) => {
    const scopePath = scopePathFromLayer(delta.layer);
    if (scopePath) {
      applyScopedDelta(delta, scopePath);
    } else {
      if (delta.action === "set") {
        deepSet(baseState, delta.key, delta.value);
      } else {
        deepRemove(baseState, delta.key);
      }
    }

    const now = new Date();
    onSync(now);
    stalenessMonitor.recordSync();

    // Check if this delta requires a restart
    if (registry && !pendingRestart) {
      const restartKeys = registry.getRestartRequiredKeys();
      if (restartKeys.includes(delta.key)) {
        pendingRestart = true;
        onRestartRequired();
        for (const listener of restartListeners) {
          listener();
        }
      }
    }

    for (const [pattern, handlers] of changeListeners) {
      if (matchGlob(pattern, delta.key)) {
        for (const handler of handlers) {
          handler([delta]);
        }
      }
    }
  });
}

function scopePathFromLayer(layer: string): ScopeInstance[] | undefined {
  if (!layer.includes(":")) return undefined;
  const scopePath: ScopeInstance[] = [];
  for (const part of layer.split("/")) {
    const separator = part.indexOf(":");
    if (separator <= 0 || separator === part.length - 1) return undefined;
    scopePath.push({
      scopeId: part.slice(0, separator),
      value: part.slice(separator + 1),
    });
  }
  return scopePath;
}
