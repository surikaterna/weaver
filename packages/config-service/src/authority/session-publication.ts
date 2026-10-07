import { stageIdentity } from "../identity-snapshots";
import { identityKey } from "../layer-stack";
import { publicationRestart } from "../restart-state";
import type { RootState } from "../root-state";
import { stageViews } from "../view-snapshots";
import { initialPublication, type PublicationPlan } from "./publication";
import { type SessionReference, sessionContribution } from "./session-bindings";

/** Remove privilege even when the fallback no longer satisfies its schema. */
export function stageSession(
  state: RootState,
  ref: SessionReference,
  add: boolean,
): PublicationPlan {
  const draft = initialPublication(state);
  const ready = new Map(state.ready);
  const key = identityKey(ref.target.identity);
  const previous = ready.get(key);
  if (!previous) return draft;
  const contributions = previous.contributions.filter(
    (item) => item.selection.captured !== ref.selection.captured,
  );
  if (add) contributions.push(sessionContribution(ref));
  contributions.sort((a, b) => a.selection.rank - b.selection.rank);
  ready.set(
    key,
    stageIdentity(
      previous.identity,
      draft.revision,
      contributions,
      state.factory.registry,
      state.factory.options.layers.map((_, rank) => rank),
      "allow-degraded",
      state.factory.adapter.revision,
    ),
  );
  const plan = {
    ...draft,
    ready,
    views: stageViews(state.views, ready, state.factory.registry, add, true),
  };
  return { ...plan, restart: publicationRestart(state, plan) };
}
