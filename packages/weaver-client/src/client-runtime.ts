import { bootClient } from "./client-boot";
import { setupDeltaSubscription } from "./client-subscriptions";
import type { WeaverClientOptions } from "./client-types";
import {
  type ClientSchemaRegistry,
  createClientSchemaRegistry,
} from "./schema-registry";
import { createScopeLoader, type ScopeLoader } from "./scope-manager";
import { createStalenessMonitor, type StalenessMonitor } from "./staleness";
import type { WeaverTransport } from "./transport";
import type {
  ConfigDelta,
  ConfigSnapshot,
  SchemaOptions,
  Unsubscribe,
} from "./types";
import type { ValidationOptions } from "./validation";

interface ClientMutableState {
  pendingRestart: boolean;
  staleSince: Date | null;
  closedAt: Date | null;
  connected: boolean;
  lastSyncedAt: Date | null;
}

export interface ClientRuntime {
  readonly namespace: string | undefined;
  readonly transport: WeaverTransport;
  readonly registry: ClientSchemaRegistry | undefined;
  readonly validationOptions: ValidationOptions;
  readonly baseState: Record<string, unknown>;
  readonly revision: string;
  readonly scopeLoader: ScopeLoader;
  readonly changeListeners: Map<string, Set<(changes: ConfigDelta[]) => void>>;
  readonly restartListeners: Set<() => void>;
  readonly stalenessMonitor: StalenessMonitor;
  readonly state: ClientMutableState;
  unsubscribe: Unsubscribe;
}

export async function initializeClientRuntime(
  options: WeaverClientOptions,
): Promise<ClientRuntime> {
  const { registry, validationOptions } = schemaRuntime(options.schemas);
  const stalenessMonitor = createStalenessMonitor(options.staleness);
  const boot = await bootClient({
    namespace: options.namespace,
    transport: options.transport,
    persistence: options.persistence,
    offlineBoot: options.offlineBoot ?? !!options.persistence,
    registry,
    stalenessMonitor,
  });
  const runtime = createRuntime(
    options,
    registry,
    validationOptions,
    boot,
    stalenessMonitor,
  );
  subscribe(runtime, boot.freshSnapshot !== null);
  return runtime;
}

function schemaRuntime(schemas: WeaverClientOptions["schemas"]): {
  readonly registry: ClientSchemaRegistry | undefined;
  readonly validationOptions: ValidationOptions;
} {
  const options: SchemaOptions | undefined =
    schemas === true ? {} : schemas || undefined;
  return {
    registry: options ? createClientSchemaRegistry() : undefined,
    validationOptions: { warnOnMismatch: options?.warnOnMismatch ?? true },
  };
}

function createRuntime(
  options: WeaverClientOptions,
  registry: ClientSchemaRegistry | undefined,
  validationOptions: ValidationOptions,
  boot: Awaited<ReturnType<typeof bootClient>>,
  stalenessMonitor: StalenessMonitor,
): ClientRuntime {
  const state = {
    pendingRestart: false,
    staleSince: null,
    closedAt: null,
    connected: boot.connected,
    lastSyncedAt: boot.lastSyncedAt,
  };
  return {
    namespace: options.namespace,
    transport: options.transport,
    registry,
    validationOptions,
    baseState: boot.baseState,
    revision: boot.revision,
    scopeLoader: createScopeLoader({
      mode: options.scopeLoading ?? "lazy",
      transport: options.transport,
      initialSnapshot: boot.freshSnapshot ?? snapshotFromBoot(boot),
    }),
    changeListeners: new Map(),
    restartListeners: new Set(),
    stalenessMonitor,
    state,
    unsubscribe: () => {},
  };
}

function snapshotFromBoot(
  boot: Awaited<ReturnType<typeof bootClient>>,
): ConfigSnapshot {
  return {
    entries: boot.baseState,
    scopes: {},
    revision: boot.revision,
    timestamp: new Date().toISOString(),
  };
}

function subscribe(runtime: ClientRuntime, hasFreshSnapshot: boolean): void {
  try {
    runtime.unsubscribe = setupDeltaSubscription({
      baseState: runtime.baseState,
      transport: runtime.transport,
      registry: runtime.registry,
      changeListeners: runtime.changeListeners,
      restartListeners: runtime.restartListeners,
      stalenessMonitor: runtime.stalenessMonitor,
      onSync: (date) => {
        runtime.state.lastSyncedAt = date;
        runtime.state.connected = true;
      },
      onRestartRequired: () => {
        runtime.state.pendingRestart = true;
      },
    });
    if (hasFreshSnapshot) runtime.state.connected = true;
  } catch {
    runtime.state.connected = false;
    runtime.state.staleSince ??= new Date();
  }
}
