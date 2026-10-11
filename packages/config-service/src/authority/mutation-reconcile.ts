import { deepGet } from "@weaver-conf/config-engine";
import {
  parsePersistedRegistry,
  serializeRegistry,
} from "@weaver-conf/config-registry/persistence";
import { type LoadedContribution, loadContributions } from "../hydration";
import type { RootState } from "../root-state";
import type { MutationPlan } from "./mutation-plan";
import { initialPublication, publish, stagePublication } from "./publication";
import { disposeSessions } from "./session-lifecycle";
import { fenceWrites } from "./write-outcome";

export async function reconcileMutations(
  state: RootState,
  touched: readonly MutationPlan[],
): Promise<void> {
  fenceWrites(
    state,
    touched.map((plan) => plan.target),
  );
  const observed: LoadedContribution[] = [];
  for (const plan of touched) {
    const loaded = await loadContributions(
      [plan.target.selection],
      plan.command.identity,
    );
    observed.push(...loaded);
  }
  try {
    if (!metadataMatches(state, observed)) {
      state.schemaFence = Object.freeze(
        touched.map((plan) => plan.target.selection.captured.binding.id),
      );
      disposeSessions(state);
      return;
    }
    if (observed.some((item) => item.failed || !item.layer)) return;
    const replacements = new Map(
      observed.flatMap((item) =>
        item.layer
          ? [[item.selection.captured, item.layer.entries] as const]
          : [],
      ),
    );
    const plan = stagePublication(
      state,
      initialPublication(state),
      replacements,
    );
    publish(state, plan, "reconcile");
  } catch {
    /* An incomplete or invalid observation never installs a subset of state. */
  }
}

export function metadataMatches(
  state: RootState,
  observed: readonly LoadedContribution[],
): boolean {
  const store = state.factory.registryStorage;
  if (!store) return true;
  const target = observed.find(
    (item) => item.selection.captured === store.captured,
  );
  if (!target) return true;
  try {
    if (!target.layer || target.failed) return false;
    const raw = deepGet(target.layer.entries, "_weaver.registry.schemas");
    return (
      JSON.stringify(serializeRegistry(parsePersistedRegistry(raw))) ===
      JSON.stringify(serializeRegistry(state.factory.adapter.snapshot()))
    );
  } catch {
    return false;
  }
}
