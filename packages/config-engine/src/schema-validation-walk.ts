import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import {
  addCompositionResult,
  COMPOSITION_KEYWORDS,
  type CompositionMemo,
  createCompositionMemo,
  getCompositionBranches,
  getMemoizedCompositionMatch,
  memoizeCompositionMatch,
} from "./schema-validation-composition";
import { validateValueConstraints } from "./schema-validation-constraints";
import type { SchemaValidationPlan } from "./schema-validation-graph";
import { ownField } from "./schema-validation-own-data";
import {
  createPredicateContext,
  rejectPredicate,
  validateScalarPredicate,
} from "./schema-validation-predicate-context";
import {
  addError,
  describeTypes,
  describeValue,
  getEffectiveValue,
  isRecord,
  matchesAnyType,
  type ValidationState,
} from "./schema-validation-support";

import {
  type CompositionFrame,
  processArrayItemFrame,
  processMemberFrame,
  processRequiredFrame,
  queueArrayFrames,
  queueObjectFrames,
  type WalkFrame,
} from "./schema-validation-walk-frames";

interface WalkRuntime {
  readonly plan: SchemaValidationPlan;
  memo: CompositionMemo | undefined;
}
export function validateValuesIteratively(
  states: readonly ValidationState[],
  plan: SchemaValidationPlan,
): void {
  const pending: WalkFrame[] = [];
  const runtime: WalkRuntime = { plan, memo: undefined };
  for (let index = states.length - 1; index >= 0; index--) {
    const state = states[index];
    if (state !== undefined) pending.push({ kind: "value", state });
  }
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    processWalkFrame(frame, pending, runtime);
  }
}

function processWalkFrame(
  frame: WalkFrame,
  pending: WalkFrame[],
  runtime: WalkRuntime,
): void {
  switch (frame.kind) {
    case "required":
      processRequiredFrame(frame, pending);
      break;
    case "member":
      processMemberFrame(frame, pending);
      break;
    case "array-item":
      processArrayItemFrame(frame, pending);
      break;
    case "composition":
      processCompositionFrame(frame, pending, runtime);
      break;
    case "ordinary":
      processOrdinaryFrame(frame.state, pending);
      break;
    case "value":
      processValueFrame(frame.state, pending, runtime);
      break;
  }
}

function processValueFrame(
  state: ValidationState,
  pending: WalkFrame[],
  runtime: WalkRuntime,
): void {
  const predicateScalar =
    runtime.plan.predicateScalars?.has(state.schema) === true;
  if (validateScalarPredicate(state, predicateScalar)) return;
  const value = getEffectiveValue(
    state.schema,
    state.value,
    state.context.mode,
  );
  const effectiveState = value === state.value ? state : { ...state, value };
  if (runtime.plan.composed?.has(state.schema) !== true) {
    processOrdinaryFrame(effectiveState, pending);
    return;
  }
  pending.push({ kind: "ordinary", state: effectiveState });
  queueCompositionFrames(effectiveState, pending);
}

function queueCompositionFrames(
  state: ValidationState,
  pending: WalkFrame[],
): void {
  for (let index = COMPOSITION_KEYWORDS.length - 1; index >= 0; index--) {
    const keyword = COMPOSITION_KEYWORDS[index];
    if (keyword === undefined || !Object.hasOwn(state.schema, keyword))
      continue;
    const branches = getCompositionBranches(state.schema, keyword);
    pending.push({
      kind: "composition",
      state,
      keyword,
      branches,
      matched: 0,
      index: 0,
      branchSchema: undefined,
      branchContext: undefined,
    });
  }
}

function processOrdinaryFrame(
  state: ValidationState,
  pending: WalkFrame[],
): void {
  const value = state.value;
  if (value === undefined) {
    if (rejectPredicate(state.context)) return;
    addError(state, "invalid-type", "Value must be defined", {
      expected: describeTypes(state.schema),
      actual: "undefined",
    });
    return;
  }
  if (!matchesAnyType(value, state.schema)) {
    if (rejectPredicate(state.context)) return;
    addError(state, "invalid-type", "Value does not match schema type", {
      expected: describeTypes(state.schema),
      actual: describeValue(value),
    });
    return;
  }
  validateValueConstraints(state);
  if (Array.isArray(value)) queueArrayFrames(state, value, pending);
  else if (isRecord(value)) queueObjectFrames(state, value, pending);
}

function processCompositionFrame(
  frame: CompositionFrame,
  pending: WalkFrame[],
  runtime: WalkRuntime,
): void {
  completeCompositionBranch(frame, runtime);
  if (frame.index >= frame.branches.length) {
    const { state } = frame;
    addCompositionResult(frame, frame.matched, state.path, state.context);
    return;
  }
  const branch = ownField(frame.branches, frame.index);
  frame.index++;
  if (branch === undefined) {
    pending.push(frame);
    return;
  }
  queueCompositionBranch(frame, branch, pending, runtime);
}

function queueCompositionBranch(
  frame: CompositionFrame,
  schema: ConfigurationPropertySchema,
  pending: WalkFrame[],
  runtime: WalkRuntime,
): void {
  const { mode } = frame.state.context;
  const memoEligible = runtime.plan.memoEligible?.has(schema) === true;
  const memo = runtime.memo;
  const cached =
    memoEligible && memo !== undefined
      ? getMemoizedCompositionMatch(memo, schema, frame.state.value, mode)
      : undefined;
  if (cached !== undefined) {
    if (cached) frame.matched++;
    pending.push(frame);
    return;
  }
  const context = createPredicateContext(mode);
  const state = { ...frame.state, schema, context };
  frame.branchSchema = schema;
  frame.branchContext = context;
  pending.push(frame);
  pending.push({ kind: "value", state });
}

function completeCompositionBranch(
  frame: CompositionFrame,
  runtime: WalkRuntime,
): void {
  const schema = frame.branchSchema;
  const context = frame.branchContext;
  if (schema === undefined || context === undefined) return;
  const matches = !context.failed;
  if (runtime.plan.memoEligible?.has(schema) === true) {
    runtime.memo ??= createCompositionMemo();
    memoizeCompositionMatch(
      runtime.memo,
      schema,
      frame.state.value,
      context.mode,
      matches,
    );
  }
  if (matches) frame.matched++;
  frame.branchSchema = undefined;
  frame.branchContext = undefined;
}
