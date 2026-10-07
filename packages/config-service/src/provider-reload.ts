import { deepEqual } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type Result,
  type WeaverError,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import { metadataMatches } from "./authority/mutation-reconcile";
import {
  initialPublication,
  type PublicationPlan,
  publish,
  validateCandidate,
} from "./authority/publication";
import { type LoadedContribution, loadContributions } from "./hydration";
import {
  type IdentitySnapshot,
  resolveIdentitySnapshot,
  stageIdentity,
} from "./identity-snapshots";
import type { CapturedBinding } from "./provider-binding";
import { errorData } from "./resource-ownership";
import { publicationRestart } from "./restart-state";
import { assertReadable, type RootState } from "./root-state";
import { stageViews } from "./view-snapshots";

function admitReload(
  state: RootState,
  id: string,
  cause: "reload" | "external",
) {
  assertReadable(state);
  if (state.writeHookActive)
    throw createWeaverError(
      "WRITE_UNAVAILABLE",
      "Host hook reentry is unavailable",
    );
  const binding = state.factory.captured.find((item) => item.binding.id === id);
  if (!binding) throw createWeaverError("VALIDATION_ERROR", "Unknown provider");
  if (cause === "external" && state.writeFence)
    throw createWeaverError(
      "WRITE_UNAVAILABLE",
      "External observation is fenced",
    );
  return binding;
}

export async function reloadProvider(
  state: RootState,
  id: string,
  cause: "reload" | "external" = "reload",
  started: () => void = () => {},
): Promise<Result<undefined, WeaverError>> {
  try {
    admitReload(state, id, cause);
    return await state.queue.enqueue(async () => {
      const binding = admitReload(state, id, cause);
      try {
        started();
        if (!bindingUsed(state, binding))
          return { ok: true, value: undefined } as const;
        if (cause === "reload") await binding.refresh?.();
        assertReadable(state);
        const plan = await stageReload(state, binding);
        assertReadable(state);
        state.reloadFailures = Object.freeze(
          (state.reloadFailures ?? []).filter((item) => item !== id),
        );
        if (plan) publish(state, plan, cause);
        return { ok: true, value: undefined } as const;
      } catch (error) {
        if (!state.disposed)
          state.reloadFailures = Object.freeze([
            ...new Set([...(state.reloadFailures ?? []), id]),
          ]);
        if (error instanceof WeaverErrorInstance && error.code === "DISPOSED")
          throw error;
        throw createWeaverError(
          "SERVER_DEGRADED",
          "Provider observation failed",
        );
      }
    });
  } catch (error) {
    return {
      ok: false,
      error: errorData(
        error instanceof WeaverErrorInstance ? error.code : "SERVER_DEGRADED",
        "Provider observation unavailable",
      ),
    };
  }
}

function bindingUsed(state: RootState, binding: CapturedBinding): boolean {
  return [...state.ready.values()].some((snapshot) =>
    snapshot.contributions.some((item) => item.selection.captured === binding),
  );
}

async function observe(
  state: RootState,
  target: LoadedContribution,
  identity: Parameters<CapturedBinding["load"]>[0],
): Promise<LoadedContribution> {
  assertReadable(state);
  const [loaded] = await loadContributions([target.selection], identity);
  assertReadable(state);
  if (!loaded || loaded.failed || !loaded.layer)
    throw createWeaverError("SERVER_DEGRADED", "Provider observation failed");
  if (!metadataMatches(state, [loaded])) {
    state.schemaFence = Object.freeze([target.selection.captured.binding.id]);
    disposeSessions(state);
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Observed registry differs from owned metadata",
    );
  }
  return loaded;
}

async function stageReload(
  state: RootState,
  binding: CapturedBinding,
): Promise<PublicationPlan | undefined> {
  const draft = initialPublication(state);
  const ready = new Map(state.ready);
  const fixedTarget = state.fixed.find(
    (item) => item.selection.captured === binding,
  );
  const fixed =
    fixedTarget && binding.binding.operation.kind !== "read"
      ? await observe(state, fixedTarget, state.factory.options.identity)
      : undefined;
  let changed = false;
  for (const [key, previous] of state.ready) {
    const target = previous.contributions.find(
      (item) => item.selection.captured === binding,
    );
    if (!target) continue;
    const loaded = fixed ?? (await observe(state, target, previous.identity));
    if (
      deepEqual(target.layer, loaded.layer) &&
      target.failed === loaded.failed
    )
      continue;
    const contributions = previous.contributions.map((item) =>
      item === target ? loaded : item,
    );
    ready.set(
      key,
      stageObserved(state, previous, draft.revision, contributions),
    );
    changed = true;
  }
  if (!changed) return;
  const plan = Object.freeze({
    ...draft,
    ready,
    fixed: fixed
      ? state.fixed.map((item) => (item === fixedTarget ? fixed : item))
      : state.fixed,
    views: stageViews(state.views, ready, state.factory.registry, true),
  });
  return Object.freeze({ ...plan, restart: publicationRestart(state, plan) });
}

function stageObserved(
  state: RootState,
  previous: IdentitySnapshot,
  revision: string,
  contributions: readonly LoadedContribution[],
): IdentitySnapshot {
  const ranks = state.factory.options.layers.map((_, rank) => rank);
  const effective = resolveIdentitySnapshot(contributions, ranks);
  validateCandidate(state, previous, contributions, effective.entries);
  return stageIdentity(
    previous.identity,
    revision,
    contributions,
    state.factory.registry,
    ranks,
    state.factory.options.failureMode,
    state.factory.adapter.revision,
  );
}

import { disposeSessions } from "./authority/session-lifecycle";
