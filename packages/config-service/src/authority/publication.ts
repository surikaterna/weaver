import type { CanonicalSchemaRegistryReader } from "@weaver-conf/config-registry";
import { createWeaverError } from "@weaver-conf/config-types";
import { type LoadedContribution, requireHealthy } from "../hydration";
import {
  type IdentitySnapshot,
  resolveIdentitySnapshot,
  stageIdentity,
} from "../identity-snapshots";
import type { RootState } from "../root-state";
import type { WriteTicket } from "./authority-write";
import { anchorValidation, prepareConfigMutation } from "./schema-admission";
import { checkProjection, rejectAtomicAncestors } from "./write-policy";

export interface PublicationPlan {
  readonly ready: Map<string, IdentitySnapshot>;
  readonly fixed: readonly LoadedContribution[];
  readonly generation: number;
  readonly revision: string;
}
function replace(
  contributions: readonly LoadedContribution[],
  target: LoadedContribution,
  entries: Record<string, unknown>,
): readonly LoadedContribution[] {
  return contributions.map((item) => {
    if (item.selection.captured !== target.selection.captured) return item;
    if (!item.layer)
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Configuration contribution unavailable",
      );
    return Object.freeze({
      ...item,
      layer: Object.freeze({ ...item.layer, entries }),
    });
  });
}
function validateAll(
  registry: CanonicalSchemaRegistryReader,
  environment: string,
  entries: Record<string, unknown>,
  effective: Record<string, unknown>,
): void {
  for (const identity of registry.listRegisteredSchemaIdentities().anchors) {
    if (identity.environment !== environment) continue;
    const anchor = registry.getRegisteredSchema(identity.path, environment);
    if (!anchor || anchorValidation(anchor, entries, effective))
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Configuration candidate is invalid",
      );
  }
}
function prepareEntries(
  state: RootState,
  ticket: WriteTicket,
  target: LoadedContribution,
  snapshot: IdentitySnapshot,
): Record<string, unknown> {
  if (!target.layer)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Configuration contribution unavailable",
    );
  rejectAtomicAncestors(target.layer.entries, ticket.request.path);
  checkProjection(snapshot, ticket.request.path);
  const prepared = prepareConfigMutation({
    registry: state.factory.registry,
    environment: snapshot.identity.environment,
    mutations: [
      {
        key: ticket.key,
        operation: ticket.operation,
        ...(ticket.operation === "set" ? { value: ticket.value } : {}),
      },
    ],
    layerBefore: target.layer.entries,
    effectiveAfter: (entries) =>
      resolveIdentitySnapshot(
        replace(snapshot.contributions, target, entries),
        state.factory.options.layers.map((_, rank) => rank),
      ).entries,
  });
  if (!prepared.success) {
    const code = prepared.result.error?.code;
    throw createWeaverError(
      code === "SCHEMA_NOT_REGISTERED" || code === "UNSUPPORTED_OPERATION"
        ? code
        : "VALIDATION_ERROR",
      "Configuration candidate is invalid",
    );
  }
  return prepared.layerAfter;
}
export function stagePublication(
  state: RootState,
  ticket: WriteTicket,
  target: LoadedContribution,
  observed?: Record<string, unknown>,
): PublicationPlan {
  const ready = new Map(state.ready);
  const generation = state.generation + 1;
  const revision = `${state.incarnation}${generation}`;
  let entries = observed;
  for (const [key, snapshot] of state.ready) {
    if (
      !snapshot.contributions.some(
        (item) => item.selection.captured === target.selection.captured,
      )
    )
      continue;
    const candidate = stageAffected(
      state,
      ticket,
      target,
      snapshot,
      revision,
      observed,
    );
    entries ??= candidate.entries;
    ready.set(key, candidate.snapshot);
  }
  if (!entries)
    throw createWeaverError(
      "INTERNAL_ERROR",
      "Configuration candidate unavailable",
    );
  return Object.freeze({
    ready,
    fixed: replace(state.fixed, target, entries),
    generation,
    revision,
  });
}
function stageAffected(
  state: RootState,
  ticket: WriteTicket,
  target: LoadedContribution,
  snapshot: IdentitySnapshot,
  revision: string,
  observed?: Record<string, unknown>,
) {
  requireHealthy(snapshot.contributions, "fail");
  const entries = observed ?? prepareEntries(state, ticket, target, snapshot);
  const contributions = replace(snapshot.contributions, target, entries);
  const ranks = state.factory.options.layers.map((_, rank) => rank);
  const effective = resolveIdentitySnapshot(contributions, ranks);
  validateAll(
    state.factory.registry,
    snapshot.identity.environment,
    entries,
    effective.entries,
  );
  return {
    entries,
    snapshot: stageIdentity(
      snapshot.identity,
      revision,
      contributions,
      state.factory.registry,
      ranks,
      "fail",
    ),
  };
}
/** All fallible work and allocation precedes dispatch; commit has no callbacks. */
export function publish(state: RootState, plan: PublicationPlan): void {
  state.ready = plan.ready;
  state.fixed = plan.fixed;
  state.generation = plan.generation;
}
