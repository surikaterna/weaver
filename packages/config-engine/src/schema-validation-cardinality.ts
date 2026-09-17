import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { deepEqual } from "./deep-equal";
import {
  addBoundedContextError,
  addContextError,
  appendValidationPath,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

export function validateObjectSize(
  schema: ConfigurationPropertySchema,
  value: Record<string, unknown>,
  path: ValidationPath,
  context: ValidationContext,
): void {
  if (context.mode === "effective") {
    addBoundedContextError(
      context,
      path,
      "minProperties",
      Object.keys(value).length,
      schema.minProperties,
      ">=",
    );
  }
  addBoundedContextError(
    context,
    path,
    "maxProperties",
    Object.keys(value).length,
    schema.maxProperties,
    "<=",
  );
}

export function validateArraySize(
  schema: ConfigurationPropertySchema,
  value: readonly unknown[],
  path: ValidationPath,
  context: ValidationContext,
): void {
  addBoundedContextError(
    context,
    path,
    "minItems",
    value.length,
    schema.minItems,
    ">=",
  );
  addBoundedContextError(
    context,
    path,
    "maxItems",
    value.length,
    schema.maxItems,
    "<=",
  );
}

export function validateUniqueItems(
  schema: ConfigurationPropertySchema,
  value: readonly unknown[],
  path: ValidationPath,
  context: ValidationContext,
): void {
  if (schema.uniqueItems !== true) return;
  for (let left = 0; left < value.length; left++) {
    if (!Object.hasOwn(value, left)) continue;
    for (let right = left + 1; right < value.length; right++) {
      if (!Object.hasOwn(value, right)) continue;
      if (deepEqual(value[left], value[right])) {
        addContextError(
          context,
          "invalid-value",
          appendValidationPath(path, right),
          { message: "Array item must be unique" },
        );
      }
    }
  }
}
