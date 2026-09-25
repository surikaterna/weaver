import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  validateArraySize,
  validateObjectSize,
  validateUniqueItems,
} from "./schema-validation-cardinality";
import {
  addCompositionResult,
  COMPOSITION_KEYWORDS,
  type CompositionKeyword,
  type CompositionMemo,
  createCompositionMemo,
  getCompositionBranches,
  getMemoizedCompositionMatch,
  memoizeCompositionMatch,
} from "./schema-validation-composition";
import { validateValueConstraints } from "./schema-validation-constraints";
import type { SchemaValidationPlan } from "./schema-validation-graph";
import { collectMemberSchemas, itemSchema } from "./schema-validation-paths";
import {
  appendContextPath,
  createPredicateContext,
  rejectPredicate,
  validateScalarPredicate,
} from "./schema-validation-predicate-context";
import { queuePredicateObjectFrames } from "./schema-validation-predicate-object";
import {
  addContextError,
  addError,
  describeTypes,
  describeValue,
  getEffectiveValue,
  hasOwn,
  isRecord,
  matchesAnyType,
  type ValidationPath,
  type ValidationState,
} from "./schema-validation-support";

type WalkFrame =
  | { readonly kind: "value"; readonly state: ValidationState }
  | { readonly kind: "ordinary"; readonly state: ValidationState }
  | CompositionFrame
  | RequiredFrame
  | MemberFrame
  | ArrayItemFrame;

interface RequiredFrame {
  readonly kind: "required";
  readonly state: ValidationState;
  readonly key: string;
}

interface MemberFrame {
  readonly kind: "member";
  readonly state: ValidationState;
  readonly key: string;
  readonly value: unknown;
}

interface ArrayItemFrame {
  readonly kind: "array-item";
  readonly state: ValidationState;
  readonly value: readonly unknown[];
  readonly index: number;
}

interface CompositionFrame {
  readonly kind: "composition";
  readonly state: ValidationState;
  readonly keyword: CompositionKeyword;
  readonly branches: readonly ConfigurationPropertySchema[];
  matched: number;
  index: number;
  branchSchema?: ConfigurationPropertySchema | undefined;
  branchContext?: ValidationState["context"] | undefined;
}

interface WalkRuntime {
  readonly plan: SchemaValidationPlan;
  memo?: CompositionMemo;
}

export function validateValuesIteratively(
  states: readonly ValidationState[],
  plan: SchemaValidationPlan,
): void {
  const pending: WalkFrame[] = [];
  const runtime: WalkRuntime = { plan };
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
  if (frame.kind === "required") {
    processRequiredFrame(frame, pending);
  } else if (frame.kind === "member") {
    processMemberFrame(frame, pending);
  } else if (frame.kind === "array-item") {
    processArrayItemFrame(frame, pending);
  } else if (frame.kind === "composition") {
    processCompositionFrame(frame, pending, runtime);
  } else if (frame.kind === "ordinary") {
    processOrdinaryFrame(frame.state, pending);
  } else {
    processValueFrame(frame.state, pending, runtime);
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
  const branch = frame.branches[frame.index];
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
  const cached =
    memoEligible && runtime.memo !== undefined
      ? getMemoizedCompositionMatch(
          runtime.memo,
          schema,
          frame.state.value,
          mode,
        )
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

function queueObjectFrames(
  state: ValidationState,
  value: Record<string, unknown>,
  pending: WalkFrame[],
): void {
  validateObjectSize(state.schema, value, state.path, state.context);
  if (queuePredicateObjectFrames(state, value, pending)) return;
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry !== undefined) {
      pending.push({ kind: "member", state, key: entry[0], value: entry[1] });
    }
  }
  if (state.context.mode !== "effective") return;
  const required = Object.hasOwn(state.schema, "required")
    ? (state.schema.required ?? [])
    : [];
  for (let index = required.length - 1; index >= 0; index--) {
    const key = required[index];
    if (key !== undefined) pending.push({ kind: "required", state, key });
  }
}

function processRequiredFrame(
  frame: RequiredFrame,
  pending: WalkFrame[],
): void {
  if (!isRecord(frame.state.value) || hasOwn(frame.state.value, frame.key))
    return;
  const path = appendContextPath(
    frame.state.context,
    frame.state.path,
    frame.key,
  );
  const properties = Object.hasOwn(frame.state.schema, "properties")
    ? frame.state.schema.properties
    : undefined;
  const propertySchema =
    properties !== undefined && Object.hasOwn(properties, frame.key)
      ? properties[frame.key]
      : undefined;
  if (propertySchema?.default !== undefined) {
    pending.push({
      kind: "value",
      state: { ...frame.state, schema: propertySchema, value: undefined, path },
    });
    return;
  }
  addContextError(frame.state.context, "missing-required", path, {
    message: `Required property "${frame.key}" is missing`,
  });
}

function processMemberFrame(frame: MemberFrame, pending: WalkFrame[]): void {
  const { schema, path, context } = frame.state;
  const childPath = appendContextPath(context, path, frame.key);
  const schemas = collectMemberSchemas(schema, frame.key, path, context);
  if (schemas.length === 0) {
    queueAdditionalProperty(frame, childPath, pending);
    return;
  }
  for (let index = schemas.length - 1; index >= 0; index--) {
    const memberSchema = schemas[index];
    if (memberSchema !== undefined) {
      pending.push({
        kind: "value",
        state: {
          schema: memberSchema,
          value: frame.value,
          path: childPath,
          context,
        },
      });
    }
  }
}

function queueAdditionalProperty(
  frame: MemberFrame,
  path: ValidationPath,
  pending: WalkFrame[],
): void {
  const additional = Object.hasOwn(frame.state.schema, "additionalProperties")
    ? frame.state.schema.additionalProperties
    : undefined;
  if (additional === true) return;
  if (additional === undefined || additional === false) {
    addContextError(frame.state.context, "unknown-property", path, {
      message: `Unknown property "${frame.key}" is not allowed`,
    });
    return;
  }
  pending.push({
    kind: "value",
    state: { ...frame.state, schema: additional, value: frame.value, path },
  });
}

function queueArrayFrames(
  state: ValidationState,
  value: readonly unknown[],
  pending: WalkFrame[],
): void {
  validateArraySize(state.schema, value, state.path, state.context);
  validateUniqueItems(state.schema, value, state.path, state.context);
  for (let index = value.length - 1; index >= 0; index--) {
    pending.push({ kind: "array-item", state, value, index });
  }
}

function processArrayItemFrame(
  frame: ArrayItemFrame,
  pending: WalkFrame[],
): void {
  const path = appendContextPath(
    frame.state.context,
    frame.state.path,
    frame.index,
  );
  if (!Object.hasOwn(frame.value, frame.index)) {
    addContextError(frame.state.context, "invalid-value", path, {
      message: "Array item must be present",
    });
    return;
  }
  const schema = itemSchema(frame.state.schema, frame.index);
  if (schema === undefined) return;
  pending.push({
    kind: "value",
    state: {
      ...frame.state,
      schema,
      value: frame.value[frame.index],
      path,
    },
  });
}
