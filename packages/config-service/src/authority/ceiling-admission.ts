import {
  type ConfigurationSnapshot,
  deepEqual,
  inspectResolvedPath,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import { registeredCeilingEvidence } from "@weaver-conf/config-registry";
import { createWeaverError } from "@weaver-conf/config-types";
import { identityKey } from "../layer-stack";
import type { RootState } from "../root-state";
import { deriveView } from "../view-snapshots";
import type { MutationTicket } from "./authority-write";
import { compileMutationPath } from "./mutation-capture";
import type { MutationPlan } from "./mutation-plan";
import { checkedSessionMutation } from "./session-mutations";

export function admitCeilingMutation(
  state: RootState,
  ticket: MutationTicket,
  plan: MutationPlan,
): void {
  const names = state.factory.options.layers.map((slot) => slot.layer);
  const rank = names.indexOf(plan.command.layer);
  if (rank < 0)
    throw createWeaverError("VALIDATION_ERROR", "Unknown layer rank");
  const emergency =
    plan.session &&
    checkedSessionMutation(state, ticket, plan.command).emergency;
  const { before, after } = mutationSnapshots(plan);
  const admit = (
    old: ConfigurationSnapshot,
    next: ConfigurationSnapshot,
    path: string,
  ) => {
    const evidence = registeredCeilingEvidence(state.factory.registry, {
      environment: plan.command.identity.environment,
      registryRevision: state.factory.adapter.revision,
      layerNames: names,
      candidates: [...old.layers, ...next.layers],
    });
    check(evidence.ceilings, path, rank, emergency === true, old, next);
  };
  admit(before.raw, after.raw, compileMutationPath(plan.command));
  if (plan.command.viewId === undefined) return;
  const selection = {
    identity: plan.command.identity,
    namespace: plan.command.namespace,
    viewId: plan.command.viewId,
  };
  const oldView = deriveView(
    before,
    selection,
    state.factory.registry,
    false,
  ).raw;
  const newView = deriveView(
    after,
    selection,
    state.factory.registry,
    false,
  ).raw;
  admit(oldView, newView, plan.command.path);
}

function mutationSnapshots(plan: MutationPlan) {
  const key = identityKey(plan.command.identity);
  const before = plan.before.ready.get(key);
  const after = plan.after.ready.get(key);
  if (!before || !after)
    throw createWeaverError("INTERNAL_ERROR", "Missing mutation snapshot");
  return { before, after };
}

function check(
  ceilings: readonly {
    readonly path: readonly string[];
    readonly maxRank: number;
  }[],
  path: string,
  rank: number,
  emergency: boolean,
  before: ConfigurationSnapshot,
  after: ConfigurationSnapshot,
): void {
  const target = parseCanonicalConfigPath(path).segments;
  for (const ceiling of ceilings) {
    if (emergency || rank <= ceiling.maxRank) continue;
    if (
      prefix(target, ceiling.path) ||
      prefix(ceiling.path, target) ||
      !deepEqual(
        inspectResolvedPath(before, ceiling.path).effectiveValue,
        inspectResolvedPath(after, ceiling.path).effectiveValue,
      )
    )
      throw createWeaverError(
        "POLICY_VIOLATION",
        "Mutation exceeds registered ceiling",
      );
  }
}
function prefix(parent: readonly string[], child: readonly string[]): boolean {
  return (
    parent.length <= child.length &&
    parent.every((key, index) => key === child[index])
  );
}
