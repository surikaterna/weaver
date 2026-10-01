import { createWeaverError } from "@weaver-conf/config-types";
import {
  defineOwnData,
  isPlainObject,
  ownDataValue,
  pushOwn,
} from "./own-data";
import { observeResolution } from "./resolution-observation";
import {
  atomicOrigin,
  type OriginNode,
  type RecordOrigin,
  recordOrigin,
} from "./resolution-origins";
import {
  type PolicyContext,
  policyAllows,
  type ResolutionPolicy,
} from "./resolution-policy";
import type { ResolutionOrigin } from "./snapshot-contracts";

export { isPlainObject } from "./own-data";

export interface ObservedMerge {
  readonly origin: ResolutionOrigin;
  readonly policy: ResolutionPolicy;
  readonly rank: number;
}
export interface MergeResult {
  readonly entries: Record<string, unknown>;
  readonly origin: RecordOrigin | undefined;
}
interface Frame {
  readonly base: Record<string, unknown> | undefined;
  readonly override: Record<string, unknown>;
  readonly prior: OriginNode | undefined;
  readonly context: PolicyContext | undefined;
  readonly result: Record<string, unknown>;
  readonly children: Map<string, OriginNode>;
  keys: readonly string[];
  readonly assign: (result: MergeResult) => void;
  index: number;
  initialized: boolean;
}
type Memo = WeakMap<
  object,
  Map<
    object | undefined,
    Map<
      OriginNode | undefined,
      Map<PolicyContext | undefined, MergeResult | "active">
    >
  >
>;

export function mergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  return traverse(base, override).entries;
}

export function mergeObservedRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  prior: RecordOrigin | undefined,
  observed: ObservedMerge,
): MergeResult {
  return traverse(base, override, prior, observed);
}

function makeFrame(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown>,
  prior: OriginNode | undefined,
  context: PolicyContext | undefined,
  assign: Frame["assign"],
): Frame {
  const result: Record<string, unknown> = {};
  observeResolution("mergeRequests");
  return {
    base,
    override,
    prior,
    context,
    result,
    children: new Map(),
    keys: [],
    index: 0,
    initialized: false,
    assign,
  };
}

function memoBucket(
  memo: Memo,
  frame: Frame,
): Map<PolicyContext | undefined, MergeResult | "active"> {
  let bases = memo.get(frame.override);
  if (!bases) {
    bases = new Map();
    memo.set(frame.override, bases);
  }
  let origins = bases.get(frame.base);
  if (!origins) {
    origins = new Map();
    bases.set(frame.base, origins);
  }
  let contexts = origins.get(frame.prior);
  if (!contexts) {
    contexts = new Map();
    origins.set(frame.prior, contexts);
  }
  return contexts;
}

function traverse(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  prior?: RecordOrigin,
  observed?: ObservedMerge,
): MergeResult {
  let result: MergeResult = { entries: {}, origin: undefined };
  const memo: Memo = new WeakMap();
  const atomic = observed ? atomicOrigin(observed.origin) : undefined;
  const frames = [
    makeFrame(
      base,
      override,
      prior,
      observed?.policy.rootForRank(observed.rank),
      (value) => {
        result = value;
      },
    ),
  ];
  while (frames.length) {
    const frame = frames[frames.length - 1];
    if (!frame) break;
    if (!frame.initialized) {
      const cached = enterFrame(frame, memo);
      if (cached) {
        frames.pop();
        frame.assign(cached);
        continue;
      }
    }
    const key =
      frame.index < frame.keys.length ? frame.keys[frame.index++] : undefined;
    if (key !== undefined) {
      applyKey(frame, key, frames, atomic, observed);
      continue;
    }
    frames.pop();
    const complete = completeFrame(frame, observed);
    memoBucket(memo, frame).set(frame.context, complete);
    frame.assign(complete);
  }
  return result;
}

function enterFrame(frame: Frame, memo: Memo): MergeResult | undefined {
  const bucket = memoBucket(memo, frame);
  const cached = bucket.get(frame.context);
  if (cached === "active")
    throw createWeaverError("VALIDATION_ERROR", "Cyclic merge context");
  if (cached) return cached;
  bucket.set(frame.context, "active");
  if (frame.base) {
    for (const key of Object.keys(frame.base)) {
      defineOwnData(frame.result, key, ownDataValue(frame.base, key));
      observeResolution("mergeBaseEdges");
    }
  }
  if (frame.prior?.kind === "record") {
    for (const [key, child] of frame.prior.children)
      frame.children.set(key, child);
  }
  frame.keys = Object.keys(frame.override);
  frame.initialized = true;
  observeResolution("mergeNodes");
  return undefined;
}

function completeFrame(
  frame: Frame,
  observed: ObservedMerge | undefined,
): MergeResult {
  const empty =
    frame.base && frame.keys.length !== 0
      ? (frame.prior?.summary ?? "empty")
      : undefined;
  const origin = observed
    ? recordOrigin(frame.children, empty ?? observed.origin)
    : undefined;
  return { entries: frame.result, origin };
}

function applyKey(
  frame: Frame,
  key: string,
  frames: Frame[],
  atomic: OriginNode | undefined,
  observed: ObservedMerge | undefined,
): void {
  observeResolution("mergeEdges");
  const value = ownDataValue(frame.override, key);
  if (value === undefined && frame.base !== undefined) return;
  const base = ownDataValue(frame.result, key);
  const context =
    observed && frame.context
      ? observed.policy.child(frame.context, key, observed.rank)
      : undefined;
  if (observed && context && !policyAllows(context, observed.rank, value, base))
    return;
  if (isPlainObject(value) && (isPlainObject(base) || observed)) {
    const merging = isPlainObject(base);
    const child = makeFrame(
      merging ? base : undefined,
      value,
      merging ? frame.children.get(key) : undefined,
      context,
      (result) => {
        defineOwnData(frame.result, key, result.entries);
        if (result.origin) frame.children.set(key, result.origin);
      },
    );
    pushOwn(frames, child);
    return;
  }
  defineOwnData(frame.result, key, value);
  if (atomic) frame.children.set(key, atomic);
}
