import {
  type ConfigurationServiceIdentity,
  createWeaverError,
} from "@weaver-conf/config-types";
import { loadContributions } from "./hydration";
import { stageIdentity } from "./identity-snapshots";
import { identityKey, selectBindings } from "./layer-stack";
import { assertReadable, type RootState } from "./root-state";

export interface PendingIdentity {
  readonly promise: Promise<void>;
  readonly guards: Set<() => void>;
}

/** Work is shared, permission is not: every caller retains its own final guard. */
export function prepareIdentity(
  state: RootState,
  identity: ConfigurationServiceIdentity,
  guard: () => void,
): Promise<void> {
  assertReadable(state);
  guard();
  if (state.writeHookActive)
    throw createWeaverError("FORBIDDEN", "Authority callback reentry denied");
  const key = identityKey(identity);
  if (state.ready.has(key)) return Promise.resolve();
  assertHydrationAvailable(state);
  const existing = state.pending.get(key);
  if (existing) {
    existing.guards.add(guard);
    return existing.promise;
  }
  const guards = new Set([guard]);
  const promise = state.queue.enqueue(() =>
    hydrateIdentity(state, identity, guards),
  );
  state.pending.set(key, { promise, guards });
  void promise.then(
    () => state.pending.delete(key),
    () => state.pending.delete(key),
  );
  return promise;
}

function assertHydrationAvailable(state: RootState): void {
  assertReadable(state);
  if (state.writeFence)
    throw createWeaverError(
      "WRITE_UNAVAILABLE",
      "Configuration recovery requires a new root",
    );
}

function requireWaiter(guards: ReadonlySet<() => void>): void {
  for (const guard of guards) {
    try {
      guard();
      return;
    } catch {
      /* A revoked waiter cannot cancel other principals. */
    }
  }
  throw createWeaverError(
    "FORBIDDEN",
    "No authorized hydration waiter remains",
  );
}

export async function hydrateIdentity(
  state: RootState,
  identity: ConfigurationServiceIdentity,
  guards: ReadonlySet<() => void>,
): Promise<void> {
  assertHydrationAvailable(state);
  requireWaiter(guards);
  if (state.ready.has(identityKey(identity))) return;
  const selected = selectBindings(
    state.factory.options,
    state.factory.captured,
    identity,
  );
  const scopes = await loadContributions(
    selected.filter(
      (item) =>
        item.kind === "scope" ||
        item.captured.binding.operation.kind === "read",
    ),
    identity,
  );
  assertHydrationAvailable(state);
  requireWaiter(guards);
  const retained = [...scopes, ...state.fixed];
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
  const staged = stageIdentity(
    identity,
    `${state.incarnation}${state.generation + 1}`,
    contributions,
    state.factory.registry,
    state.factory.options.layers.map((_, rank) => rank),
    state.factory.options.failureMode,
    state.factory.adapter.revision,
  );
  assertReadable(state);
  requireWaiter(guards);
  state.ready.set(identityKey(identity), staged);
  state.generation++;
}
