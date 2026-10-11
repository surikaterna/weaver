import { stageIdentity } from "../identity-snapshots";
import {
  captureResolutionContext,
  type ResolutionContext,
} from "../resolution-context";
import { publicationRestart } from "../restart-state";
import type { RootState } from "../root-state";
import { stageViews } from "../view-snapshots";
import type { PublicationPlan } from "./publication";

/** Accepted effects remain accepted; only expired/revoked source eligibility changes. */
export function refreshPublicationEligibility(
  state: RootState,
  plan: PublicationPlan,
): PublicationPlan {
  const ready = new Map(plan.ready);
  let changed = false;
  for (const [key, snapshot] of plan.ready) {
    const context = captureResolutionContext(
      state,
      snapshot.identity,
      snapshot.resolution.registry,
      snapshot.registryRevision,
    );
    if (sameSessions(snapshot.resolution, context)) continue;
    ready.set(
      key,
      stageIdentity(
        snapshot.identity,
        plan.revision,
        snapshot.contributions,
        context,
        "allow-degraded",
      ),
    );
    changed = true;
  }
  if (!changed) return plan;
  const registry =
    ready.values().next().value?.resolution.registry ?? state.factory.registry;
  const refreshed = {
    ...plan,
    ready,
    views: stageViews(plan.views, ready, registry, false, true),
  };
  return { ...refreshed, restart: publicationRestart(state, refreshed) };
}

function sameSessions(
  before: ResolutionContext,
  after: ResolutionContext,
): boolean {
  return (
    before.sessions.size === after.sessions.size &&
    [...before.sessions.keys()].every((source) => after.sessions.has(source))
  );
}
