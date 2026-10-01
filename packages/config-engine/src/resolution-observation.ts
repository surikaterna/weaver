import { pushOwn } from "./own-data";
import type { OriginNode } from "./resolution-origins";

type Metric =
  | "copyNodes"
  | "copyEdges"
  | "mergeNodes"
  | "mergeRequests"
  | "mergeBaseEdges"
  | "mergeEdges"
  | "originNodes"
  | "originEdges"
  | "retainedOriginNodes"
  | "retainedOriginEdges"
  | "policyNodes"
  | "freezeNodes"
  | "freezeEdges"
  | "inspectSteps";
let observation: Partial<Record<Metric, number>> | undefined;

// Private opt-in instrumentation for deterministic graph tests, never a package API.
export function beginResolutionObservation(): void {
  observation = {};
}

export function endResolutionObservation(): Readonly<
  Partial<Record<Metric, number>>
> {
  const result = Object.freeze({ ...observation });
  observation = undefined;
  return result;
}

export function observeResolution(metric: Metric, count = 1): void {
  if (observation) observation[metric] = (observation[metric] ?? 0) + count;
}

export function observeOriginGraph(root: OriginNode): void {
  if (!observation) return;
  const pending: OriginNode[] = [root];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const node = pending.pop();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    observeResolution("retainedOriginNodes");
    if (node.kind !== "record") continue;
    for (const child of node.children.values()) {
      observeResolution("retainedOriginEdges");
      pushOwn(pending, child);
    }
  }
}
