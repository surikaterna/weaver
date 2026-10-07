import {
  type ConfigurationReaderChange,
  createWeaverError,
} from "@weaver-conf/config-types";
import { type LoadedContribution, requireHealthy } from "../hydration";
import {
  type IdentitySnapshot,
  resolveIdentitySnapshot,
  stageIdentity,
} from "../identity-snapshots";
import type { CapturedBinding } from "../provider-binding";
import {
  publicationRestart,
  type ReloadBehavior,
  strongest,
} from "../restart-state";
import type { RootState } from "../root-state";
import { type PreparedView, stageViews } from "../view-snapshots";
import { anchorValidation } from "./schema-admission";

export interface PublicationPlan {
  readonly ready: Map<string, IdentitySnapshot>;
  readonly views: Map<string, PreparedView>;
  readonly fixed: readonly LoadedContribution[];
  readonly generation: number;
  readonly revision: string;
  readonly restart?: ReloadBehavior;
}
export type Replacements = ReadonlyMap<
  CapturedBinding,
  Record<string, unknown>
>;

export function initialPublication(state: RootState): PublicationPlan {
  return {
    ready: state.ready,
    views: state.views,
    fixed: state.fixed,
    generation: state.generation + 1,
    revision: `${state.incarnation}${String(state.generation + 1)}`,
  };
}

export function replaceContributions(
  contributions: readonly LoadedContribution[],
  replacements: Replacements,
): readonly LoadedContribution[] {
  return contributions.map((item) => {
    const entries = replacements.get(item.selection.captured);
    if (!entries) return item;
    if (!item.layer)
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Configuration contribution unavailable",
      );
    return Object.freeze({
      ...item,
      layer: resolutionLayerSchema.parse({ ...item.layer, entries }),
    });
  });
}

export function stagePublication(
  state: RootState,
  draft: PublicationPlan,
  replacements: Replacements,
): PublicationPlan {
  const ready = new Map(draft.ready);
  const ranks = state.factory.options.layers.map((_, rank) => rank);
  for (const [key, snapshot] of draft.ready) {
    if (
      !snapshot.contributions.some((item) =>
        replacements.has(item.selection.captured),
      )
    )
      continue;
    const contributions = replaceContributions(
      snapshot.contributions,
      replacements,
    );
    requireHealthy(contributions, "fail");
    const effective = resolveIdentitySnapshot(contributions, ranks);
    validateCandidate(state, snapshot, contributions, effective.entries);
    ready.set(
      key,
      stageIdentity(
        snapshot.identity,
        draft.revision,
        contributions,
        state.factory.registry,
        ranks,
        "fail",
        state.factory.adapter.revision,
      ),
    );
  }
  const plan = Object.freeze({
    ...draft,
    ready,
    views: stageViews(draft.views, ready, state.factory.registry, true),
    fixed: replaceContributions(draft.fixed, replacements),
  });
  return Object.freeze({ ...plan, restart: publicationRestart(state, plan) });
}

export function validateCandidate(
  state: RootState,
  snapshot: IdentitySnapshot,
  contributions: readonly LoadedContribution[],
  effective: Record<string, unknown>,
): void {
  for (const identity of state.factory.registry.listRegisteredSchemaIdentities()
    .anchors) {
    if (identity.environment !== snapshot.identity.environment) continue;
    const anchor = state.factory.registry.getRegisteredSchema(
      identity.path,
      identity.environment,
    );
    if (
      !anchor ||
      contributions.some(
        (item) =>
          item.layer && anchorValidation(anchor, item.layer.entries, effective),
      )
    )
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Configuration candidate is invalid",
      );
  }
}

/** No resolution, validation, callbacks or awaits may occur in publication. */
export function publish(
  state: RootState,
  plan: PublicationPlan,
  cause: ConfigurationReaderChange["cause"] = "mutation",
): void {
  const before = initialPublication(state);
  state.ready = plan.ready;
  state.views = plan.views;
  state.fixed = plan.fixed;
  state.generation = plan.generation;
  state.restartPending = strongest(
    state.restartPending ?? "hot",
    plan.restart ?? "hot",
  );
  state.events.publish(before, plan, cause, state.queue.settled());
}

import { resolutionLayerSchema } from "@weaver-conf/config-engine";
