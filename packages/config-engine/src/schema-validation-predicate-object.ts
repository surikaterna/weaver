import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { ownEntries, ownField } from "./schema-validation-own-data";

import { hasOwn, type ValidationState } from "./schema-validation-support";

type PredicateFrameSink = (frame: {
  readonly kind: "value";
  readonly state: ValidationState;
}) => void;

export function queuePredicateObjectFrames(
  state: ValidationState,
  value: Record<string, unknown>,
  pending: PredicateFrameSink,
): boolean {
  if (state.context.predicateOnly !== true) return false;
  const patterns = ownField(state.schema, "patternProperties");
  if (patterns !== undefined) return false;
  const entries = ownEntries(value);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry !== undefined) queueMember(state, entry[0], entry[1], pending);
  }
  queueRequired(state, value, pending);
  return true;
}

function queueMember(
  state: ValidationState,
  key: string,
  value: unknown,
  pending: PredicateFrameSink,
): void {
  const properties = ownField(state.schema, "properties");
  const declared =
    properties !== undefined && Object.hasOwn(properties, key)
      ? ownField(properties, key)
      : undefined;
  if (declared !== undefined) {
    pending({
      kind: "value",
      state: { ...state, schema: declared, value },
    });
    return;
  }
  const additional = ownField(state.schema, "additionalProperties");
  if (additional === true) return;
  if (additional === undefined || additional === false) {
    state.context.failed = true;
    return;
  }
  pending({
    kind: "value",
    state: { ...state, schema: additional, value },
  });
}

function queueRequired(
  state: ValidationState,
  value: Record<string, unknown>,
  pending: PredicateFrameSink,
): void {
  if (state.context.mode !== "effective") return;
  const required = ownField(state.schema, "required") ?? [];
  for (let index = required.length - 1; index >= 0; index--) {
    const key = ownField(required, index);
    if (key === undefined || hasOwn(value, key)) continue;
    const propertySchema = ownPropertySchema(state.schema, key);
    if (
      propertySchema !== undefined &&
      ownField(propertySchema, "default") !== undefined
    ) {
      pending({
        kind: "value",
        state: { ...state, schema: propertySchema, value: undefined },
      });
    } else {
      state.context.failed = true;
    }
  }
}

function ownPropertySchema(
  schema: ConfigurationPropertySchema,
  key: string,
): ConfigurationPropertySchema | undefined {
  const properties = ownField(schema, "properties");
  return properties !== undefined && Object.hasOwn(properties, key)
    ? ownField(properties, key)
    : undefined;
}
