// schemas-property.ts — Zod schemas for configuration property schema types

import { z } from "zod";

import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
} from "./property-schema";
import {
  createObjectSchemaPropertyGraphSchema,
  createSchemaPropertyGraphSchema,
} from "./schema-property-graph";
import {
  configurationJsonSchemaTypeSchema,
  weaverPropertyExtensionsSchema,
} from "./schemas-policy";

const shallowConfigurationPropertySchema = z.strictObject({
  type: z.union([
    configurationJsonSchemaTypeSchema,
    z.array(configurationJsonSchemaTypeSchema).readonly(),
  ]),
  title: z.string().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
  examples: z.array(z.unknown()).readonly().optional(),
  const: z.unknown().optional(),
  enum: z.array(z.unknown()).readonly().optional(),
  format: z.string().optional(),
  pattern: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  multipleOf: z.number().positive().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(),
  uniqueItems: z.boolean().optional(),
  minProperties: z.number().int().nonnegative().optional(),
  maxProperties: z.number().int().nonnegative().optional(),
  required: z.array(z.string()).readonly().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  patternProperties: z.record(z.string(), z.unknown()).optional(),
  additionalProperties: z.union([z.boolean(), z.unknown()]).optional(),
  items: z.unknown().optional(),
  oneOf: z.unknown().optional(),
  anyOf: z.unknown().optional(),
  allOf: z.unknown().optional(),
  not: z.unknown().optional(),

  // Unsupported by policy (self-contained schemas only)
  $ref: z.never().optional(),
  $defs: z.never().optional(),

  "x-weaver": weaverPropertyExtensionsSchema.optional(),
});

export const configurationPropertySchemaSchema: z.ZodType<ConfigurationPropertySchema> =
  createSchemaPropertyGraphSchema(shallowConfigurationPropertySchema, false);

export const objectConfigurationPropertySchemaSchema: z.ZodType<ObjectConfigurationPropertySchema> =
  createObjectSchemaPropertyGraphSchema(shallowConfigurationPropertySchema);
