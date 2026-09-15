import { z } from "zod";
import { snapshotBuiltinSchema } from "./builtin-schema-snapshot";

/** Immutable executable view. The underlying Zod instance is never exposed here. */
export interface BuiltinSchemaView<T> {
  readonly safeParse: (input: unknown) => z.ZodSafeParseResult<T>;
  readonly jsonSchema: Readonly<z.core.JSONSchema.BaseSchema>;
  readonly acceptsDefault: (
    path: readonly (string | number)[],
    value: unknown,
  ) => boolean;
}

const parseSchema = z.safeParse;
const describeSchema = z.toJSONSchema;

export function createBuiltinSchemaView<T>(
  schema: z.ZodType<T>,
): BuiltinSchemaView<T> {
  const snapshot = snapshotBuiltinSchema(schema);
  const jsonSchema = freezeSchemaDescription(describeSchema(snapshot));
  return Object.freeze({
    safeParse: (input: unknown) => parseSchema(snapshot, input),
    jsonSchema,
    acceptsDefault: (path: readonly (string | number)[], value: unknown) => {
      if (path.at(-2) === "properties" && path.at(-1) === "version")
        return false;
      return acceptsAtPath(snapshot, path, value);
    },
  });
}

function acceptsAtPath(
  schema: unknown,
  path: readonly (string | number)[],
  value: unknown,
): boolean {
  if (!(schema instanceof z.ZodType)) return false;
  if (path.length === 0) return parseSchema(schema, value).success;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodLazy
  )
    return acceptsAtPath(schema.unwrap(), path, value);
  if (schema instanceof z.ZodUnion)
    return schema.options.every((option) => acceptsAtPath(option, path, value));
  const [edge, key, ...rest] = path;
  if (edge === "properties" && typeof key === "string")
    return acceptsProperty(schema, key, rest, value);
  if (edge === "additionalProperties" && schema instanceof z.ZodRecord)
    return acceptsAtPath(schema.valueType, path.slice(1), value);
  if (edge === "items" && schema instanceof z.ZodArray)
    return acceptsAtPath(
      schema.element,
      path.slice(typeof key === "number" ? 2 : 1),
      value,
    );
  if (
    edge === "items" &&
    typeof key === "number" &&
    schema instanceof z.ZodTuple
  ) {
    const item = schema.def.items[key];
    return item !== undefined && acceptsAtPath(item, rest, value);
  }
  return false;
}

function acceptsProperty(
  schema: z.ZodType,
  key: string,
  path: readonly (string | number)[],
  value: unknown,
): boolean {
  if (schema instanceof z.ZodObject) {
    const property: unknown = Object.hasOwn(schema.shape, key)
      ? schema.shape[key]
      : undefined;
    return (
      property instanceof z.ZodType && acceptsAtPath(property, path, value)
    );
  }
  if (schema instanceof z.ZodRecord)
    return (
      parseSchema(schema.keyType, key).success &&
      acceptsAtPath(schema.valueType, path, value)
    );
  return false;
}

function freezeSchemaDescription<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeSchemaDescription(child);
    Object.freeze(value);
  }
  return value;
}
