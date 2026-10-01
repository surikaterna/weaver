import { observeResolution } from "./resolution-observation";
import type { ResolutionOrigin } from "./snapshot-contracts";

export type OriginSummary = ResolutionOrigin | "mixed" | "empty";
export type OriginNode = AtomicOrigin | RecordOrigin;
interface AtomicOrigin {
  readonly kind: "atomic";
  readonly summary: ResolutionOrigin;
}
export interface RecordOrigin {
  readonly kind: "record";
  readonly children: ReadonlyMap<string, OriginNode>;
  readonly summary: OriginSummary;
}

export function atomicOrigin(origin: ResolutionOrigin): AtomicOrigin {
  observeResolution("originNodes");
  return Object.freeze({ kind: "atomic", summary: origin });
}

export function recordOrigin(
  children: Map<string, OriginNode>,
  empty: OriginSummary,
): RecordOrigin {
  let summary: OriginSummary | undefined;
  for (const child of children.values()) {
    observeResolution("originEdges");
    summary = combineSummary(summary, child.summary);
  }
  observeResolution("originNodes");
  return Object.freeze({ kind: "record", children, summary: summary ?? empty });
}

function combineSummary(
  left: OriginSummary | undefined,
  right: OriginSummary,
): OriginSummary {
  if (left === undefined) return right;
  if (left === "empty") return right;
  if (right === "empty") return left;
  if (left === "mixed" || right === "mixed") return "mixed";
  return left.layer === right.layer && left.providerId === right.providerId
    ? left
    : "mixed";
}
