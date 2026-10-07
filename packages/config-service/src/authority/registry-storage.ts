import { deepSet } from "@weaver-conf/config-engine";
import { serializeRegistry } from "@weaver-conf/config-registry/persistence";
import { createWeaverError } from "@weaver-conf/config-types";
import type { LoadedContribution } from "../hydration";
import { stageIdentity } from "../identity-snapshots";
import type { RootState } from "../root-state";
import { dispatchEffect } from "./registry-effects";

const registryKey = "_weaver.registry.schemas";

export function registryStore(state: RootState) {
  const selection = state.factory.registryStorage;
  if (!selection) return undefined;
  const writer = state.factory.writers.get(selection.captured);
  const target = state.fixed.find(
    (item) => item.selection.captured === selection.captured,
  );
  if (!writer)
    throw createWeaverError(
      "WRITE_UNAVAILABLE",
      "Registry storage is read-only",
    );
  if (!target?.layer || target.failed)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Registry storage is unavailable",
    );
  return { writer, target };
}

export function stageRegistryStorage(state: RootState, payload: unknown) {
  const store = registryStore(state);
  if (!store) return undefined;
  const entries = structuredClone(store.target.layer?.entries ?? {});
  deepSet(entries, registryKey, payload);
  return {
    ...store,
    entries,
    dispatch: () =>
      dispatchEffect(store.writer, () =>
        store.writer.write(registryKey, payload),
      ),
  };
}

export function replaceRegistryContribution(
  contributions: readonly LoadedContribution[],
  storage: ReturnType<typeof stageRegistryStorage>,
): readonly LoadedContribution[] {
  if (!storage) return contributions;
  return contributions.map((item) => {
    if (item.selection.captured !== storage.target.selection.captured)
      return item;
    if (!item.layer)
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Registry storage is unavailable",
      );
    return Object.freeze({
      ...item,
      layer: Object.freeze({ ...item.layer, entries: storage.entries }),
    });
  });
}

export async function persistSeed(state: RootState): Promise<void> {
  if (!state.factory.registryStorage || !state.factory.options.schemas.length)
    return;
  const storage = stageRegistryStorage(
    state,
    serializeRegistry(state.factory.adapter.snapshot()),
  );
  if (!storage) return;
  const fixed = replaceRegistryContribution(state.fixed, storage);
  const ready = new Map(state.ready);
  for (const [key, snapshot] of state.ready)
    ready.set(
      key,
      stageIdentity(
        snapshot.identity,
        snapshot.revision,
        replaceRegistryContribution(snapshot.contributions, storage),
        state.factory.registry,
        state.factory.options.layers.map((_, rank) => rank),
        state.factory.options.failureMode,
        state.factory.adapter.revision,
      ),
    );
  const outcome = await storage.dispatch();
  if (outcome !== "committed")
    throw createWeaverError(
      outcome === "unknown" ? "WRITE_OUTCOME_UNKNOWN" : "WRITE_ERROR",
      "Registry initialization failed",
    );
  state.fixed = fixed;
  state.ready = ready;
}
