import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { pushOwn } from "./own-data";
import {
  validateArraySize,
  validateObjectSize,
  validateUniqueItems,
} from "./schema-validation-cardinality";
import type { CompositionKeyword } from "./schema-validation-composition";
import { ownEntries, ownField } from "./schema-validation-own-data";
import { collectMemberSchemas, itemSchema } from "./schema-validation-paths";
import { appendContextPath } from "./schema-validation-predicate-context";
import { queuePredicateObjectFrames } from "./schema-validation-predicate-object";
import {
  addContextError,
  hasOwn,
  isRecord,
  type ValidationPath,
  type ValidationState,
} from "./schema-validation-support";

export type WalkFrame =
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

export interface CompositionFrame {
  readonly kind: "composition";
  readonly state: ValidationState;
  readonly keyword: CompositionKeyword;
  readonly branches: readonly ConfigurationPropertySchema[];
  matched: number;
  index: number;
  branchSchema: ConfigurationPropertySchema | undefined;
  branchContext: ValidationState["context"] | undefined;
}

export function queueObjectFrames(
  state: ValidationState,
  value: Record<string, unknown>,
  pending: WalkFrame[],
): void {
  validateObjectSize(state.schema, value, state.path, state.context);
  if (
    queuePredicateObjectFrames(state, value, (frame) => pushOwn(pending, frame))
  )
    return;
  const entries = ownEntries(value);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry !== undefined)
      pushOwn(pending, {
        kind: "member",
        state,
        key: entry[0],
        value: entry[1],
      });
  }
  if (state.context.mode !== "effective") return;
  const required = ownField(state.schema, "required") ?? [];
  for (let index = required.length - 1; index >= 0; index--) {
    const key = ownField(required, index);
    if (key !== undefined) pushOwn(pending, { kind: "required", state, key });
  }
}

export function processRequiredFrame(
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
  const properties = ownField(frame.state.schema, "properties");
  const propertySchema =
    properties === undefined ? undefined : ownField(properties, frame.key);
  if (
    propertySchema !== undefined &&
    ownField(propertySchema, "default") !== undefined
  ) {
    pushOwn(pending, {
      kind: "value",
      state: { ...frame.state, schema: propertySchema, value: undefined, path },
    });
    return;
  }
  addContextError(frame.state.context, "missing-required", path, {
    message: `Required property "${frame.key}" is missing`,
  });
}

export function processMemberFrame(
  frame: MemberFrame,
  pending: WalkFrame[],
): void {
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
      pushOwn(pending, {
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
  const additional = ownField(frame.state.schema, "additionalProperties");
  if (additional === true) return;
  if (additional === undefined || additional === false) {
    addContextError(frame.state.context, "unknown-property", path, {
      message: `Unknown property "${frame.key}" is not allowed`,
    });
    return;
  }
  pushOwn(pending, {
    kind: "value",
    state: { ...frame.state, schema: additional, value: frame.value, path },
  });
}

export function queueArrayFrames(
  state: ValidationState,
  value: readonly unknown[],
  pending: WalkFrame[],
): void {
  validateArraySize(state.schema, value, state.path, state.context);
  validateUniqueItems(state.schema, value, state.path, state.context);
  for (let index = value.length - 1; index >= 0; index--) {
    pushOwn(pending, { kind: "array-item", state, value, index });
  }
}

export function processArrayItemFrame(
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
  pushOwn(pending, {
    kind: "value",
    state: {
      ...frame.state,
      schema,
      value: ownField(frame.value, frame.index),
      path,
    },
  });
}
