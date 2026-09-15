import { bootClient } from "./client-boot";
import { setupDeltaSubscription } from "./client-subscriptions";
import type { WeaverClientOptions } from "./client-types";
import {
  type ClientSchemaRegistry,
  createClientSchemaRegistry,
} from "./schema-registry";
import { createScopeLoader } from "./scope-manager";
import { createStalenessMonitor } from "./staleness";
import type { ConfigDelta, SchemaOptions, Unsubscribe } from "./types";

export type ClientState = ReturnType<typeof assembleState>;

export async function createClientState(options: WeaverClientOptions) {
  const registry = options.schemas ? createClientSchemaRegistry() : undefined;
  const stalenessMonitor = createStalenessMonitor(options.staleness);
  const boot = await bootClient({
    namespace: options.namespace,
    transport: options.transport,
    persistence: options.persistence,
    offlineBoot: options.offlineBoot ?? !!options.persistence,
    registry,
    stalenessMonitor,
  });
  const state = assembleState(options, boot, registry, stalenessMonitor);
  subscribeClient(state, !!boot.freshSnapshot);
  return state;
}

function assembleState(
  options: WeaverClientOptions,
  boot: Awaited<ReturnType<typeof bootClient>>,
  registry: ClientSchemaRegistry | undefined,
  stalenessMonitor: ReturnType<typeof createStalenessMonitor>,
) {
  const schemaOpts: SchemaOptions | undefined =
    options.schemas === true ? {} : options.schemas || undefined;
  const status: {
    pendingRestart: boolean;
    staleSince: Date | null;
    closedAt: Date | null;
    unsubTransport: Unsubscribe;
  } = {
    pendingRestart: false,
    staleSince: null,
    closedAt: null,
    unsubTransport: () => {},
  };
  return {
    ...status,
    namespace: options.namespace,
    transport: options.transport,
    registry,
    stalenessMonitor,
    validationOptions: { warnOnMismatch: schemaOpts?.warnOnMismatch ?? true },
    baseState: boot.baseState,
    revision: boot.revision,
    connected: boot.connected,
    lastSyncedAt: boot.lastSyncedAt,
    scopeLoader: createScopeLoader({
      mode: options.scopeLoading ?? "lazy",
      transport: options.transport,
      initialSnapshot: boot.freshSnapshot ?? {
        entries: boot.baseState,
        scopes: {},
        revision: boot.revision,
        timestamp: new Date().toISOString(),
      },
    }),
    changeListeners: new Map<string, Set<(changes: ConfigDelta[]) => void>>(),
    restartListeners: new Set<() => void>(),
  };
}

function subscribeClient(state: ClientState, fresh: boolean): void {
  try {
    state.unsubTransport = setupDeltaSubscription({
      baseState: state.baseState,
      transport: state.transport,
      registry: state.registry,
      changeListeners: state.changeListeners,
      restartListeners: state.restartListeners,
      stalenessMonitor: state.stalenessMonitor,
      onSync: (date) => {
        state.lastSyncedAt = date;
        state.connected = true;
      },
      onRestartRequired: () => {
        state.pendingRestart = true;
      },
      applyScopedDelta: (delta, path) =>
        state.scopeLoader.applyDelta(delta, path),
    });
    if (fresh) state.connected = true;
  } catch {
    state.connected = false;
    if (!state.staleSince) state.staleSince = new Date();
  }
}
