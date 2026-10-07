import type {
  ConfigurationService,
  ConfigurationServiceIdentity,
  ConfigurationServiceOptions,
  Result,
  WeaverError,
} from "@weaver-conf/config-types";
import {
  announceAuthority,
  createHostAuthority,
} from "./authority/host-authority";
import { persistSeed } from "./authority/registry-storage";
import { validateFactory } from "./factory-validation";
import { acknowledgeRestart, flushHost } from "./host-lifecycle";
import { type LoadedContribution, loadContributions } from "./hydration";
import { prepareIdentity } from "./identity-hydration";
import { type IdentitySnapshot, stageIdentity } from "./identity-snapshots";
import { identityKey } from "./layer-stack";
import { createOperationQueue } from "./operation-queue";
import { reloadProvider } from "./provider-reload";
import { startProviderWatches } from "./provider-watch";
import {
  cleanupResult,
  closeResources,
  initializationError,
  ownProviders,
} from "./resource-ownership";
import { assertNotDisposed, type RootState } from "./root-state";
import { createServiceEvents } from "./service-events";
import type { ConfigurationServiceHostOptions } from "./service-host";

/** Initial hydration and registration finish before the root can escape. */
export async function createConfigurationService(
  options: ConfigurationServiceOptions,
  host: ConfigurationServiceHostOptions,
): Promise<ConfigurationService> {
  const factory = validateFactory(options, host);
  const incarnation = `${globalThis.crypto.randomUUID()}:`;
  const providers = ownProviders(factory.options.providers);
  const loaded = await loadContributions(
    factory.selected,
    factory.options.identity,
  );
  const state: RootState = {
    factory,
    providers,
    ready: new Map(),
    views: new Map(),
    pending: new Map(),
    events: createServiceEvents(),
    fixed: loaded.filter((item) => item.selection.kind === "fixed"),
    disposed: false,
    generation: 0,
    queue: createOperationQueue(),
    incarnation,
  };
  try {
    const initial = stage(state, factory.options.identity, loaded);
    state.generation = 1;
    state.ready.set(identityKey(initial.identity), initial);
    await persistSeed(state);
    state.authority = createHostAuthority(state, (identity, guard) =>
      prepareIdentity(state, identity, guard),
    );
    const root = rootFacade(state);
    const activate = startProviderWatches(state);
    announceAuthority(state);
    activate();
    return root;
  } catch (error) {
    return failInitialization(state, error);
  }
}

async function failInitialization(
  state: RootState,
  error: unknown,
): Promise<never> {
  state.disposed = true;
  const failedWatches = (await state.stopWatching?.()) ?? [];
  await state.queue.settled();
  state.events.clear();
  state.ready.clear();
  state.views.clear();
  throw initializationError(error, [
    ...failedWatches,
    ...(await closeResources(state.providers)),
  ]);
}

function stage(
  state: RootState,
  identity: ConfigurationServiceIdentity,
  loaded: readonly LoadedContribution[],
): IdentitySnapshot {
  return stageIdentity(
    identity,
    `${state.incarnation}${state.generation + 1}`,
    loaded,
    state.factory.registry,
    state.factory.options.layers.map((_, rank) => rank),
    state.factory.options.failureMode,
    state.factory.adapter.revision,
  );
}

function rootFacade(state: RootState): ConfigurationService {
  return Object.freeze({
    ...rootMethods(state),
    get mode() {
      return health(state).length ? "degraded" : "live";
    },
    get degradedProviders() {
      return health(state);
    },
    get restartState() {
      assertNotDisposed(state);
      const pending = state.restartPending;
      return Object.freeze({
        revision: `${state.incarnation}${String(state.generation)}`,
        pending: pending === undefined || pending === "hot" ? "none" : pending,
      });
    },
  });
}

function health(state: RootState): readonly string[] {
  assertNotDisposed(state);
  return Object.freeze([
    ...new Set([
      ...[...state.ready.values()].flatMap(
        (snapshot) => snapshot.degradedProviders,
      ),
      ...(state.writeFence ?? []),
      ...(state.schemaFence ?? []),
      ...(state.reloadFailures ?? []),
    ]),
  ]);
}

function rootMethods(
  state: RootState,
): Pick<
  ConfigurationService,
  "reloadProvider" | "flush" | "dispose" | "acknowledgeRestart"
> {
  return {
    acknowledgeRestart: (revision) => acknowledgeRestart(state, revision),
    async reloadProvider(id) {
      return reloadProvider(state, id);
    },
    async flush() {
      return flushHost(state);
    },
    dispose() {
      return dispose(state);
    },
  };
}

function dispose(state: RootState): Promise<Result<undefined, WeaverError>> {
  if (state.disposal) return state.disposal;
  state.disposed = true;
  state.events.clear();
  const stopped = state.stopWatching?.() ?? Promise.resolve([]);
  state.disposal = state.queue.settled().then(async () => {
    const failed = [
      ...(await stopped),
      ...(await closeResources(state.providers)),
    ];
    state.ready.clear();
    state.views.clear();
    return cleanupResult(failed);
  });
  return state.disposal;
}
