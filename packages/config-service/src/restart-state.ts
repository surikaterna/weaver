import { deepEqual, inspectResolvedPath } from "@weaver-conf/config-engine";
import { registeredMutationEvidence } from "@weaver-conf/config-registry";
import type { ConfigurationReaderSelection } from "@weaver-conf/config-types";
import type { PublicationPlan } from "./authority/publication";
import type { IdentitySnapshot } from "./identity-snapshots";
import type { RootState } from "./root-state";

export type ReloadBehavior = "hot" | "rolling-restart" | "restart-required";
export function strongest(
  left: ReloadBehavior,
  right: ReloadBehavior,
): ReloadBehavior {
  if (left === "restart-required" || right === "restart-required")
    return "restart-required";
  if (left === "rolling-restart" || right === "rolling-restart")
    return "rolling-restart";
  return "hot";
}

export function changeReloadBehavior(
  previous: IdentitySnapshot,
  current: IdentitySnapshot,
  path: readonly string[],
  before: unknown,
  after: unknown,
  selection?: ConfigurationReaderSelection,
): ReloadBehavior {
  let result: ReloadBehavior = "hot";
  const pending = [{ path, before, after }];
  while (pending.length) {
    const next = pending.pop();
    if (!next || deepEqual(next.before, next.after)) continue;
    const old = objectValue(next.before),
      value = objectValue(next.after);
    const keys = new Set([...Object.keys(old), ...Object.keys(value)]);
    if (
      !keys.size ||
      Array.isArray(next.before) !== Array.isArray(next.after)
    ) {
      result = strongest(result, policyAt(previous, next.path, selection));
      result = strongest(result, policyAt(current, next.path, selection));
    }
    for (const key of keys) {
      if (key === "instances") continue;
      pending.push({
        path: [...next.path, key],
        before: old[key],
        after: value[key],
      });
    }
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function policyAt(
  snapshot: IdentitySnapshot,
  path: readonly string[],
  selection?: ConfigurationReaderSelection,
): ReloadBehavior {
  const paths = [path];
  if (selection?.viewId !== undefined) {
    const root = selection.namespace.split("/").slice(1);
    paths.push([
      ...root,
      "instances",
      selection.viewId,
      ...path.slice(root.length),
    ]);
  }
  let result: ReloadBehavior = "hot";
  for (const selected of paths)
    for (const anchor of snapshot.reloadPolicies ?? []) {
      const root = anchor.path.split("/").slice(1);
      if (!root.every((part, index) => selected[index] === part)) continue;
      const evidence = registeredMutationEvidence(
        anchor.schema,
        selected.slice(root.length),
        inspectResolvedPath(snapshot.sourceRaw ?? snapshot.raw, root)
          .effectiveValue,
      );
      for (const schema of [...evidence.ancestors, ...evidence.schemas])
        result = strongest(result, schema["x-weaver"]?.reloadBehavior ?? "hot");
    }
  return result;
}

export function publicationRestart(
  state: RootState,
  plan: PublicationPlan,
): ReloadBehavior {
  let result: ReloadBehavior = "hot";
  for (const [key, current] of plan.ready) {
    const previous = state.ready.get(key);
    if (!previous || previous === current) continue;
    result = strongest(
      result,
      changeReloadBehavior(
        previous,
        current,
        [],
        previous.raw.entries,
        current.raw.entries,
      ),
    );
  }
  for (const [key, current] of plan.views) {
    const previous = state.views.get(key);
    if (previous?.status !== "ready" || current.status !== "ready") continue;
    result = strongest(
      result,
      changeReloadBehavior(
        previous.snapshot,
        current.snapshot,
        [],
        previous.snapshot.raw.entries,
        current.snapshot.raw.entries,
        current.selection,
      ),
    );
  }
  return result;
}
