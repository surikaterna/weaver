import { z } from "zod";
import { createWeaverError } from "./errors";

/** Clone the trusted executable graph, including checks and lazy cycles, before exporting public views. */
export function snapshotBuiltinSchema<T>(schema: z.ZodType<T>): z.ZodType<T> {
  const snapshot = cloneSchema(schema, new WeakMap());
  return z.clone(schema, snapshot.def);
}

function cloneSchema(
  schema: z.ZodType,
  seen: WeakMap<object, z.ZodType>,
): z.ZodType {
  const cached = seen.get(schema);
  if (cached) return cached;
  if (schema instanceof z.ZodLazy) {
    let inner: z.ZodType | undefined;
    const copy = z.clone(schema, {
      ...cloneDefinition(schema.def, seen),
      getter: () => {
        if (!inner)
          throw createWeaverError(
            "VALIDATION_ERROR",
            "Unresolved built-in schema snapshot",
          );
        return inner;
      },
    });
    seen.set(schema, copy);
    const original: unknown = schema.unwrap();
    if (!(original instanceof z.ZodType))
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Unsupported built-in lazy schema",
      );
    inner = cloneSchema(original, seen);
    return copy;
  }
  const copy = z.clone(schema, cloneDefinition(schema.def, seen));
  seen.set(schema, copy);
  return copy;
}

function cloneDefinition<T extends object>(
  definition: T,
  seen: WeakMap<object, z.ZodType>,
): T {
  const copy = { ...definition };
  for (const [key, value] of Object.entries(definition)) {
    Object.defineProperty(copy, key, {
      value: clonePart(value, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function clonePart(value: unknown, seen: WeakMap<object, z.ZodType>): unknown {
  if (value instanceof z.ZodType) return cloneSchema(value, seen);
  if (value instanceof z.core.$ZodCheck) {
    const internals = value._zod;
    if (!("constr" in internals) || typeof internals.constr !== "function")
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Unsupported built-in schema check",
      );
    const copy: unknown = Reflect.construct(internals.constr, [
      cloneDefinition(internals.def, seen),
    ]);
    if (!(copy instanceof z.core.$ZodCheck))
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Invalid built-in schema check snapshot",
      );
    // superRefine installs its code closure after constructing the base check.
    if (typeof copy._zod.check !== "function")
      copy._zod.check = internals.check;
    return copy;
  }
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value))
    return value.map((item: unknown) => clonePart(item, seen));
  if (value !== null && typeof value === "object")
    return cloneDefinition(value, seen);
  return value;
}
