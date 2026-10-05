import {
  type ConfigurationServiceIdentity,
  type ConfigurationServiceOptions,
  type ConfigurationServiceWriteResult,
  configurationServiceIdentitySchema,
  createWeaverError,
  type HydratedConfigurationService,
  type Result,
  type ScopeInstance,
  type WeaverError,
} from "@weaver-conf/config-types";
import {
  announceAuthority,
  createHostAuthority,
} from "./authority/host-authority";
import { validateFactory } from "./factory-validation";
import { type LoadedContribution, loadContributions } from "./hydration";
import { type IdentitySnapshot, stageIdentity } from "./identity-snapshots";
import { currentIdentity } from "./identity-state";
import { identityKey, selectBindings } from "./layer-stack";
import { createOperationQueue } from "./operation-queue";
import {
  cleanupResult,
  closeResources,
  errorData,
  initializationError,
  ownProviders,
} from "./resource-ownership";
import { assertLive, type RootState } from "./root-state";
import { createServiceEvents } from "./service-events";
import type { ConfigurationServiceHostOptions } from "./service-host";
import { createSnapshotReader } from "./snapshot-reader";

/** Initial hydration and registration finish before the root can escape. */
export async function createConfigurationService(
  options: ConfigurationServiceOptions,
  host?: ConfigurationServiceHostOptions,
): Promise<HydratedConfigurationService> {
  const factory = validateFactory(options, host);
  const incarnation = factory.host.hostAuthority
    ? `${globalThis.crypto.randomUUID()}:`
    : "";
  const providers = ownProviders(factory.options.providers);
  const loaded = await loadContributions(
    factory.selected,
    factory.options.identity,
  );
  const state: RootState = {
    factory,
    providers,
    ready: new Map(),
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
    if (factory.host.hostAuthority)
      state.authority = createHostAuthority(state, (identity, guard) =>
        preload(state, identity.scopePath, guard),
      );
    const root = rootFacade(state, initial.identity);
    announceAuthority(state);
    return root;
  } catch (error) {
    state.disposed = true;
    await state.queue.settled();
    state.events.clear();
    state.ready.clear();
    throw initializationError(error, await closeResources(providers));
  }
}

function captureIdentity(
  state: RootState,
  scopePath: readonly ScopeInstance[],
): ConfigurationServiceIdentity {
  assertLive(state);
  const parsed = configurationServiceIdentitySchema.safeParse({
    environment: state.factory.options.identity.environment,
    scopePath,
  });
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid scope identity");
  return parsed.data;
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
  );
}

function rootFacade(
  state: RootState,
  identity: ConfigurationServiceIdentity,
): HydratedConfigurationService {
  const reader = createSnapshotReader(
    () => currentIdentity(state, identity),
    () => {
      assertLive(state);
      state.authority?.assertBound();
    },
    state.events,
    (path, operation, layer, aggregate) =>
      state.authority?.read(identity, path, operation, layer, aggregate),
  );
  return {
    ...reader,
    ...rootMethods(state),
    get identity() {
      return reader.identity;
    },
    get revision() {
      return reader.revision;
    },
    get mode() {
      const mode = reader.mode;
      return state.writeFence ? "degraded" : mode;
    },
    get degradedProviders() {
      return Object.freeze([
        ...new Set([...reader.degradedProviders, ...(state.writeFence ?? [])]),
      ]);
    },
  };
}

function rootMethods(
  state: RootState,
): Pick<
  HydratedConfigurationService,
  | "getForScope"
  | "preloadScope"
  | "set"
  | "remove"
  | "reloadProvider"
  | "flush"
  | "dispose"
> {
  return {
    ...rootWriteMethods(state),
    getForScope(path, scopePath) {
      const identity = captureIdentity(state, scopePath);
      state.authority?.read(identity, path, "read");
      return currentIdentity(state, identity).projection.get(path);
    },
    preloadScope(scopePath) {
      try {
        const token = state.authority?.capture();
        return token && state.authority
          ? state.authority.prepare(token, captureIdentity(state, scopePath))
          : preload(state, scopePath);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async reloadProvider() {
      return unsupported(state);
    },
    async flush() {
      return unsupported(state);
    },
    dispose() {
      return dispose(state);
    },
  };
}

function rootWriteMethods(
  state: RootState,
): Pick<HydratedConfigurationService, "set" | "remove"> {
  return {
    set: (path, value, options) =>
      state.authority?.set(path, value, options) ??
      Promise.resolve(rejectWrite(state)),
    remove: (path, options) =>
      state.authority?.remove(path, options) ??
      Promise.resolve(rejectWrite(state)),
  };
}

function rejectWrite(state: RootState): ConfigurationServiceWriteResult {
  return {
    success: false,
    outcome: "rejected",
    error: errorData(
      state.disposed ? "DISPOSED" : "WRITE_UNAVAILABLE",
      "Configuration writes are unavailable",
    ),
  };
}
function unsupported(state: RootState): Result<undefined, WeaverError> {
  return {
    ok: false,
    error: errorData(
      state.disposed ? "DISPOSED" : "UNSUPPORTED_OPERATION",
      "Operation is unavailable",
    ),
  };
}

function preload(
  state: RootState,
  scopePath: readonly ScopeInstance[],
  guard: () => void = () => {},
): Promise<void> {
  let identity: ConfigurationServiceIdentity;
  try {
    identity = captureIdentity(state, scopePath);
    if (state.writeHookActive)
      throw createWeaverError("FORBIDDEN", "Authority callback reentry denied");
    guard();
  } catch (error) {
    return Promise.reject(error);
  }
  const key = identityKey(identity);
  if (state.ready.has(key)) return Promise.resolve();
  if (state.writeFence)
    return Promise.reject(
      createWeaverError(
        "WRITE_UNAVAILABLE",
        "Configuration recovery requires a new root",
      ),
    );
  const existing = state.pending.get(key);
  if (existing) return existing;
  const pending = state.queue.enqueue(() =>
    hydrateScope(state, identity, guard),
  );
  state.pending.set(key, pending);
  void pending.then(
    () => {
      state.pending.delete(key);
    },
    () => {
      state.pending.delete(key);
    },
  );
  return pending;
}

async function hydrateScope(
  state: RootState,
  identity: ConfigurationServiceIdentity,
  guard: () => void,
): Promise<void> {
  assertLive(state);
  if (state.writeFence)
    throw createWeaverError(
      "WRITE_UNAVAILABLE",
      "Configuration recovery requires a new root",
    );
  guard();
  const selected = selectBindings(
    state.factory.options,
    state.factory.captured,
    identity,
  );
  const scopes = await loadContributions(
    selected.filter((item) => item.kind === "scope"),
    identity,
  );
  assertLive(state);
  guard();
  const retained = [...state.fixed, ...scopes];
  const contributions = selected.map((selection) => {
    const item = retained.find(
      (candidate) => candidate.selection.captured === selection.captured,
    );
    if (!item)
      throw createWeaverError(
        "INTERNAL_ERROR",
        "Missing retained contribution",
      );
    return item;
  });
  const staged = stage(state, identity, contributions);
  assertLive(state);
  guard();
  state.ready.set(identityKey(identity), staged);
  state.generation++;
}

function dispose(state: RootState): Promise<Result<undefined, WeaverError>> {
  if (state.disposal) return state.disposal;
  state.disposed = true;
  state.events.clear();
  state.disposal = state.queue.settled().then(async () => {
    const failed = await closeResources(state.providers);
    state.ready.clear();
    return cleanupResult(failed);
  });
  return state.disposal;
}
