import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { validateCompositionShape } from "./schema-validation-composition";
import { ownField } from "./schema-validation-own-data";
import {
  addContextError,
  compileSchemaPattern,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

export function validateSchemaNode(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
  supportsSchema: (value: unknown) => boolean,
  inspectComposition: boolean,
): boolean {
  if (!validateSchemaContainers(schema, path, context)) return false;
  if (
    inspectComposition &&
    !validateCompositionShape(schema, path, context, supportsSchema)
  )
    return false;
  if (!validateMultipleOfDefinition(schema, path, context)) return false;
  if (!validateScalarDefinitions(schema, path, context)) return false;
  if (!validatePatternDefinition(schema, path, context)) return false;
  return validatePatternProperties(schema, path, context);
}

function validateMultipleOfDefinition(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!Object.hasOwn(schema, "multipleOf")) return true;
  const divisor = ownField(schema, "multipleOf");
  if (divisor === undefined || (Number.isFinite(divisor) && divisor > 0)) {
    return true;
  }
  addContextError(context, "invalid-schema", path, {
    message: "multipleOf must be positive and finite",
  });
  return false;
}

function validatePatternDefinition(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  const pattern = ownField(schema, "pattern");
  if (pattern === undefined) {
    return true;
  }
  if (typeof pattern !== "string") {
    addContextError(context, "invalid-schema", path, {
      message: "pattern must be a string",
    });
    return false;
  }
  return compileSchemaPattern(pattern, path, context) !== undefined;
}

function validatePatternProperties(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!Object.hasOwn(schema, "patternProperties")) return true;
  const patterns = ownField(schema, "patternProperties");
  if (patterns === undefined) return true;
  for (const pattern of Object.keys(patterns)) {
    if (compileSchemaPattern(pattern, path, context) === undefined)
      return false;
  }
  return true;
}

export function validateSchemaContainers(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  for (const key of ["properties", "patternProperties"] as const) {
    const map = ownField(schema, key);
    if (map === undefined) continue;
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      addContextError(context, "invalid-schema", path, {
        message: `${key} must be an own schema map`,
      });
      return false;
    }
  }
  for (const key of ["required", "enum"] as const) {
    const values = ownField(schema, key);
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      !hasDenseDataSlots(values, key === "required")
    ) {
      addContextError(context, "invalid-schema", path, {
        message: `${key} must be a dense array`,
      });
      return false;
    }
  }
  return true;
}

function hasDenseDataSlots(
  values: readonly unknown[],
  stringsOnly: boolean,
): boolean {
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) return false;
    if (stringsOnly && typeof ownField(values, index) !== "string")
      return false;
  }
  return true;
}

function validateScalarDefinitions(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  for (const key of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ] as const) {
    const value = ownField(schema, key);
    if (value === undefined || typeof value === "number") continue;
    addContextError(context, "invalid-schema", path, {
      message: `${key} must be a number`,
    });
    return false;
  }
  const unique = ownField(schema, "uniqueItems");
  if (unique === undefined || typeof unique === "boolean") return true;
  addContextError(context, "invalid-schema", path, {
    message: "uniqueItems must be a boolean",
  });
  return false;
}
