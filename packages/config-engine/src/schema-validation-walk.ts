import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  validateArraySize,
  validateObjectSize,
  validateUniqueItems,
} from "./schema-validation-cardinality";
import {
  addCompositionResult,
  type CompositionEntry,
  type CompositionMemo,
  getCompositionEntries,
  getMemoizedCompositionMatch,
  memoizeCompositionMatch,
} from "./schema-validation-composition";
import { validateValueConstraints } from "./schema-validation-constraints";
import { collectMemberSchemas } from "./schema-validation-paths";
import {
  addContextError,
  addError,
  appendValidationPath,
  describeTypes,
  describeValue,
  getEffectiveValue,
  hasOwn,
  isRecord,
  isSchemaArray,
  matchesAnyType,
  type ValidationPath,
  type ValidationState,
} from "./schema-validation-support";

type WalkFrame =
  | { readonly kind: "value"; readonly state: ValidationState }
  | { readonly kind: "ordinary"; readonly state: ValidationState }
  | CompositionFrame
  | BranchCompleteFrame
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
  readonly entry: CompositionEntry;
  readonly progress: { matched: number };
  readonly index: number;
}

interface BranchCompleteFrame {
  readonly kind: "branch-complete";
  readonly schema: ConfigurationPropertySchema;
  readonly value: unknown;
  readonly context: ValidationState["context"];
  readonly progress: { matched: number };
}

interface WalkRuntime {
  readonly memo: CompositionMemo;
}

export function validateValuesIteratively(
  states: readonly ValidationState[],
  memo: CompositionMemo,
): void {
  const pending: WalkFrame[] = [];
  const runtime: WalkRuntime = { memo };
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
  } else if (frame.kind === "branch-complete") {
    processBranchComplete(frame, runtime);
  } else if (frame.kind === "ordinary") {
    processOrdinaryFrame(frame.state, pending);
  } else {
    processValueFrame(frame.state, pending);
  }
}

function processValueFrame(state: ValidationState, pending: WalkFrame[]): void {
  const value = getEffectiveValue(
    state.schema,
    state.value,
    state.context.mode,
  );
  const effectiveState = { ...state, value };
  pending.push({ kind: "ordinary", state: effectiveState });
  const entries = getCompositionEntries(state.schema);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined) continue;
    pending.push({
      kind: "composition",
      state: effectiveState,
      entry,
      progress: { matched: 0 },
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
    addError(state, "invalid-type", "Value must be defined", {
      expected: describeTypes(state.schema),
      actual: "undefined",
    });
    return;
  }
  if (!matchesAnyType(value, state.schema)) {
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
  const branch = frame.entry.branches[frame.index];
  if (branch === undefined) {
    addCompositionResult(
      frame.entry,
      frame.progress.matched,
      frame.state.path,
      frame.state.context,
    );
    return;
  }
  pending.push({ ...frame, index: frame.index + 1 });
  queueCompositionBranch(frame, branch, pending, runtime);
}

function queueCompositionBranch(
  frame: CompositionFrame,
  schema: ConfigurationPropertySchema,
  pending: WalkFrame[],
  runtime: WalkRuntime,
): void {
  const { mode } = frame.state.context;
  const cached = getMemoizedCompositionMatch(
    runtime.memo,
    schema,
    frame.state.value,
    mode,
  );
  if (cached !== undefined) {
    if (cached) frame.progress.matched++;
    return;
  }
  const context = { mode, errors: [] };
  pending.push({
    kind: "branch-complete",
    schema,
    value: frame.state.value,
    context,
    progress: frame.progress,
  });
  pending.push({
    kind: "value",
    state: { ...frame.state, schema, context },
  });
}

function processBranchComplete(
  frame: BranchCompleteFrame,
  runtime: WalkRuntime,
): void {
  const matches = frame.context.errors.length === 0;
  memoizeCompositionMatch(
    runtime.memo,
    frame.schema,
    frame.value,
    frame.context.mode,
    matches,
  );
  if (matches) frame.progress.matched++;
}

function queueObjectFrames(
  state: ValidationState,
  value: Record<string, unknown>,
  pending: WalkFrame[],
): void {
  validateObjectSize(state.schema, value, state.path, state.context);
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
  const path = appendValidationPath(frame.state.path, frame.key);
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
  const childPath = appendValidationPath(path, frame.key);
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
  const path = appendValidationPath(frame.state.path, frame.index);
  if (!Object.hasOwn(frame.value, frame.index)) {
    addContextError(frame.state.context, "invalid-value", path, {
      message: "Array item must be present",
    });
    return;
  }
  const itemSchema = arrayItemSchema(frame.state.schema, frame.index);
  if (itemSchema === undefined) return;
  pending.push({
    kind: "value",
    state: {
      ...frame.state,
      schema: itemSchema,
      value: frame.value[frame.index],
      path,
    },
  });
}

function arrayItemSchema(
  schema: ConfigurationPropertySchema,
  index: number,
): ConfigurationPropertySchema | undefined {
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  if (items === undefined) return undefined;
  return isSchemaArray(items) ? items[index] : items;
}
