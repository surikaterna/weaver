import { z } from "zod";
import type { ConfigurationPropertySchema } from "./property-schema";
import { isSafePattern } from "./regex-safety";
import { containsRegistrationDefaultMarker } from "./registration-default-markers";
import { objectConfigurationPropertySchemaSchema } from "./schemas-property";

export function visitConfigurationSchemas(
  schema: ConfigurationPropertySchema,
  visit: (
    schema: ConfigurationPropertySchema,
    path: readonly (string | number)[],
  ) => void,
  path: readonly (string | number)[] = [],
): void {
  visit(schema, path);
  for (const field of ["properties", "patternProperties"] as const) {
    for (const [key, child] of Object.entries(schema[field] ?? {})) {
      visitConfigurationSchemas(child, visit, [...path, field, key]);
    }
  }
  const additional = schema.additionalProperties;
  if (typeof additional === "object") {
    visitConfigurationSchemas(additional, visit, [
      ...path,
      "additionalProperties",
    ]);
  }
  visitItems(schema.items, visit, [...path, "items"]);
  for (const field of ["oneOf", "anyOf", "allOf"] as const) {
    visitItems(schema[field], visit, [...path, field]);
  }
  if (schema.not)
    visitConfigurationSchemas(schema.not, visit, [...path, "not"]);
}

function visitItems(
  items: ConfigurationPropertySchema["items"],
  visit: Parameters<typeof visitConfigurationSchemas>[1],
  path: readonly (string | number)[],
): void {
  if (!items) return;
  if ("type" in items) visitConfigurationSchemas(items, visit, path);
  else
    items.forEach((child, index) => {
      visitConfigurationSchemas(child, visit, [...path, index]);
    });
}

function checkGrammar(
  schema: ConfigurationPropertySchema,
  context: z.RefinementCtx,
): void {
  visitConfigurationSchemas(schema, (child, path) => {
    checkPatterns(child, context, path);
    if (containsRegistrationDefaultMarker(child.default)) {
      context.addIssue({
        code: "custom",
        path: [...path, "default"],
        message:
          "Registered defaults must not contain mount or secret-ref markers",
      });
    }
    if (
      Object.hasOwn(child, "default") &&
      !z.json().safeParse(child.default).success
    ) {
      context.addIssue({
        code: "custom",
        path: [...path, "default"],
        message: "Registered defaults must be JSON values",
      });
    }
    for (const keyword of ["oneOf", "anyOf", "allOf", "not"] as const) {
      if (child[keyword] === undefined) continue;
      context.addIssue({
        code: "custom",
        path: [...path, keyword],
        message: `Registered schemas do not support ${keyword}`,
      });
    }
  });
}

function checkPatterns(
  schema: ConfigurationPropertySchema,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  const patterns = Object.keys(schema.patternProperties ?? {});
  if (schema.pattern !== undefined) patterns.push(schema.pattern);
  for (const pattern of patterns) {
    if (!isSafePattern(pattern)) {
      context.addIssue({
        code: "custom",
        path: [...path],
        message: `Unsafe regex pattern ${JSON.stringify(pattern)}`,
      });
      continue;
    }
    try {
      new RegExp(pattern);
    } catch {
      context.addIssue({
        code: "custom",
        path: [...path],
        message: `Invalid schema pattern ${JSON.stringify(pattern)}`,
      });
    }
  }
}

export const registeredConfigurationSchemaSchema =
  objectConfigurationPropertySchemaSchema.superRefine(checkGrammar);
