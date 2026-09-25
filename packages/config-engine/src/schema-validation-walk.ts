import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  validateArraySize,
  validateObjectSize,
  validateUniqueItems,
} from "./schema-validation-cardinality";
import { rejectUnsupportedComposition } from "./schema-validation-composition";
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

export function validateValuesIteratively(
  states: readonly ValidationState[],
): void {
  const pending: WalkFrame[] = [];
  const visited = new WeakMap<object, WeakSet<object>>();
  for (let index = states.length - 1; index >= 0; index--) {
    const state = states[index];
    if (state !== undefined) pending.push({ kind: "value", state });
  }
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    processWalkFrame(frame, pending, visited);
  }
}

function processWalkFrame(
  frame: WalkFrame,
  pending: WalkFrame[],
  visited: WeakMap<object, WeakSet<object>>,
): void {
  if (frame.kind === "required") {
    processRequiredFrame(frame, pending);
  } else if (frame.kind === "member") {
    processMemberFrame(frame, pending);
  } else if (frame.kind === "array-item") {
    processArrayItemFrame(frame, pending);
  } else {
    processValueFrame(frame.state, pending, visited);
  }
}

function processValueFrame(
  state: ValidationState,
  pending: WalkFrame[],
  visited: WeakMap<object, WeakSet<object>>,
): void {
  if (rejectUnsupportedComposition(state.schema, state.path, state.context))
    return;
  const value = getEffectiveValue(
    state.schema,
    state.value,
    state.context.mode,
  );
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
  if (isObjectValue(value) && pairWasVisited(state.schema, value, visited))
    return;
  const effectiveState = { ...state, value };
  validateValueConstraints(effectiveState);
  if (Array.isArray(value)) queueArrayFrames(effectiveState, value, pending);
  else if (isRecord(value)) queueObjectFrames(effectiveState, value, pending);
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
  const required = state.schema.required ?? [];
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
  const properties = frame.state.schema.properties;
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
  const additional = frame.state.schema.additionalProperties;
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
  const items = schema.items;
  if (items === undefined) return undefined;
  return isSchemaArray(items) ? items[index] : items;
}

function pairWasVisited(
  schema: object,
  value: object,
  visited: WeakMap<object, WeakSet<object>>,
): boolean {
  const values = visited.get(schema);
  if (values?.has(value) === true) return true;
  if (values === undefined) visited.set(schema, new WeakSet([value]));
  else values.add(value);
  return false;
}

function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
