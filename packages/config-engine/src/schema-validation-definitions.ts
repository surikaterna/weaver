import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { validateCompositionShape } from "./schema-validation-composition";
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
  if (
    inspectComposition &&
    !validateCompositionShape(schema, path, context, supportsSchema)
  )
    return false;
  if (!validateMultipleOfDefinition(schema, path, context)) return false;
  if (!validatePatternDefinition(schema, path, context)) return false;
  return validatePatternProperties(schema, path, context);
}

function validateMultipleOfDefinition(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!Object.hasOwn(schema, "multipleOf")) return true;
  const divisor = schema.multipleOf;
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
  if (!Object.hasOwn(schema, "pattern") || schema.pattern === undefined) {
    return true;
  }
  return compileSchemaPattern(schema.pattern, path, context) !== undefined;
}

function validatePatternProperties(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!Object.hasOwn(schema, "patternProperties")) return true;
  const patterns = schema.patternProperties;
  if (patterns === undefined) return true;
  for (const pattern of Object.keys(patterns)) {
    if (compileSchemaPattern(pattern, path, context) === undefined)
      return false;
  }
  return true;
}
