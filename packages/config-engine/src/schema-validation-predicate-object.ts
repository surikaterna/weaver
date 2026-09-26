import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { hasOwn, type ValidationState } from "./schema-validation-support";

interface PredicateFrameSink {
  push(frame: {
    readonly kind: "value";
    readonly state: ValidationState;
  }): unknown;
}

export function queuePredicateObjectFrames(
  state: ValidationState,
  value: Record<string, unknown>,
  pending: PredicateFrameSink,
): boolean {
  if (state.context.predicateOnly !== true) return false;
  const patterns = Object.hasOwn(state.schema, "patternProperties")
    ? state.schema.patternProperties
    : undefined;
  if (patterns !== undefined) return false;
  const entries = Object.entries(value);
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
  const properties = Object.hasOwn(state.schema, "properties")
    ? state.schema.properties
    : undefined;
  const declared =
    properties !== undefined && Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
  if (declared !== undefined) {
    pending.push({
      kind: "value",
      state: { ...state, schema: declared, value },
    });
    return;
  }
  const additional = Object.hasOwn(state.schema, "additionalProperties")
    ? state.schema.additionalProperties
    : undefined;
  if (additional === true) return;
  if (additional === undefined || additional === false) {
    state.context.failed = true;
    return;
  }
  pending.push({
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
  const required = Object.hasOwn(state.schema, "required")
    ? (state.schema.required ?? [])
    : [];
  for (let index = required.length - 1; index >= 0; index--) {
    const key = required[index];
    if (key === undefined || hasOwn(value, key)) continue;
    const propertySchema = ownPropertySchema(state.schema, key);
    if (propertySchema?.default !== undefined) {
      pending.push({
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
  const properties = Object.hasOwn(schema, "properties")
    ? schema.properties
    : undefined;
  return properties !== undefined && Object.hasOwn(properties, key)
    ? properties[key]
    : undefined;
}
