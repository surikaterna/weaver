import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { deepEqual } from "./deep-equal";
import {
  addBoundedContextError,
  addContextError,
  type SchemaValidationPathSegment,
  type ValidationContext,
} from "./schema-validation-support";

export function validateObjectSize(
  schema: ConfigurationPropertySchema,
  value: Record<string, unknown>,
  path: readonly SchemaValidationPathSegment[],
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
  path: readonly SchemaValidationPathSegment[],
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
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): void {
  if (schema.uniqueItems !== true) return;
  for (let left = 0; left < value.length; left++) {
    for (let right = left + 1; right < value.length; right++) {
      if (deepEqual(value[left], value[right])) {
        addContextError(context, "invalid-value", [...path, right], {
          message: "Array item must be unique",
        });
      }
    }
  }
}
