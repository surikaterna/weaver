import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { deepEqual } from "./deep-equal";
import { ownField } from "./schema-validation-own-data";
import { appendContextPath } from "./schema-validation-predicate-context";
import {
  addBoundedContextError,
  addContextError,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

export function validateObjectSize(
  schema: ConfigurationPropertySchema,
  value: Record<string, unknown>,
  path: ValidationPath,
  context: ValidationContext,
): void {
  const minimum = ownField(schema, "minProperties");
  const maximum = ownField(schema, "maxProperties");
  if (context.mode === "effective" && minimum !== undefined) {
    addBoundedContextError(
      context,
      path,
      "minProperties",
      Object.keys(value).length,
      minimum,
      ">=",
    );
  }
  if (maximum === undefined) return;
  addBoundedContextError(
    context,
    path,
    "maxProperties",
    Object.keys(value).length,
    maximum,
    "<=",
  );
}

export function validateArraySize(
  schema: ConfigurationPropertySchema,
  value: readonly unknown[],
  path: ValidationPath,
  context: ValidationContext,
): void {
  const minimum = ownField(schema, "minItems");
  const maximum = ownField(schema, "maxItems");
  if (minimum !== undefined) {
    addBoundedContextError(
      context,
      path,
      "minItems",
      value.length,
      minimum,
      ">=",
    );
  }
  if (maximum !== undefined) {
    addBoundedContextError(
      context,
      path,
      "maxItems",
      value.length,
      maximum,
      "<=",
    );
  }
}

export function validateUniqueItems(
  schema: ConfigurationPropertySchema,
  value: readonly unknown[],
  path: ValidationPath,
  context: ValidationContext,
): void {
  if (ownField(schema, "uniqueItems") !== true) return;
  for (let left = 0; left < value.length; left++) {
    if (!Object.hasOwn(value, left)) continue;
    for (let right = left + 1; right < value.length; right++) {
      if (!Object.hasOwn(value, right)) continue;
      if (deepEqual(ownField(value, left), ownField(value, right))) {
        addContextError(
          context,
          "invalid-value",
          appendContextPath(context, path, right),
          { message: "Array item must be unique" },
        );
      }
    }
  }
}
