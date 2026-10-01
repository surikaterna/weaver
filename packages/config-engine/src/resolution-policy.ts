import { createWeaverError } from "@weaver-conf/config-types";
import { isPlainObject, pushOwn } from "./own-data";
import { observeResolution } from "./resolution-observation";
import type { ResolutionCeiling } from "./snapshot-contracts";

interface PlanNode {
  limit: number;
  readonly children: Map<string, PlanNode>;
}
export interface PolicyContext {
  readonly id: number;
  readonly limit: number;
  readonly minimum: number;
  readonly children: ReadonlyMap<string, PolicyContext>;
}
export interface ResolutionPolicy {
  readonly root: PolicyContext;
  rootForRank(rank: number): PolicyContext;
  child(context: PolicyContext, key: string, rank: number): PolicyContext;
}

function plan(ceilings: readonly ResolutionCeiling[]): PlanNode {
  const root: PlanNode = { limit: Infinity, children: new Map() };
  for (const ceiling of ceilings) {
    let current = root;
    for (const key of ceiling.path) {
      let next = current.children.get(key);
      if (!next) {
        next = { limit: Infinity, children: new Map() };
        current.children.set(key, next);
      }
      current = next;
    }
    current.limit = Math.min(current.limit, ceiling.maxRank);
  }
  return root;
}

export function compileResolutionPolicy(
  ceilings: readonly ResolutionCeiling[],
): ResolutionPolicy {
  const canonical = new Map<string, PolicyContext>();
  const intern = (
    limit: number,
    children: Map<string, PolicyContext>,
  ): PolicyContext => {
    const useful = new Map(
      [...children].filter(([, child]) => child.minimum < limit),
    );
    const key = JSON.stringify([
      String(limit),
      [...useful].map(([name, child]) => [name, child.id]).sort(),
    ]);
    const cached = canonical.get(key);
    if (cached) return cached;
    let minimum = limit;
    for (const child of useful.values())
      minimum = Math.min(minimum, child.minimum);
    const result = Object.freeze({
      id: canonical.size,
      limit,
      minimum,
      children: useful,
    });
    canonical.set(key, result);
    observeResolution("policyNodes");
    return result;
  };
  const root = compilePlan(plan(ceilings), intern);
  const normalize = (context: PolicyContext, rank: number) =>
    rank <= context.minimum ? intern(Infinity, new Map()) : context;
  return {
    root,
    rootForRank: (rank) => normalize(root, rank),
    child: (context, key, rank) =>
      normalize(
        context.children.get(key) ?? intern(context.limit, new Map()),
        rank,
      ),
  };
}

function compilePlan(
  root: PlanNode,
  intern: (
    limit: number,
    children: Map<string, PolicyContext>,
  ) => PolicyContext,
): PolicyContext {
  let result: PolicyContext | undefined;
  const tasks: (() => void)[] = [];
  const schedule = (
    node: PlanNode,
    inherited: number,
    assign: (value: PolicyContext) => void,
  ) => {
    pushOwn(tasks, () => {
      const limit = Math.min(inherited, node.limit);
      const children = new Map<string, PolicyContext>();
      pushOwn(tasks, () => assign(intern(limit, children)));
      for (const [key, child] of node.children)
        schedule(child, limit, (compiled) => {
          children.set(key, compiled);
        });
    });
  };
  schedule(root, Infinity, (value) => {
    result = value;
  });
  while (tasks.length) tasks.pop()?.();
  if (!result)
    throw createWeaverError("INTERNAL_ERROR", "Policy compilation invariant");
  return result;
}

export function policyAllows(
  context: PolicyContext,
  rank: number,
  value: unknown,
  base: unknown,
): boolean {
  if (rank > context.limit) return false;
  return (
    (isPlainObject(value) && !Array.isArray(base)) || rank <= context.minimum
  );
}
