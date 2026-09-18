// schemas-property.ts — Zod schemas for configuration property schema types

import { z } from "zod";

import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
} from "./property-schema";
import {
  configurationJsonSchemaTypeSchema,
  weaverPropertyExtensionsSchema,
} from "./schemas-policy";

export const configurationPropertySchemaSchema: z.ZodType<ConfigurationPropertySchema> =
  z.lazy(() =>
    z.strictObject({
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
      properties: z
        .record(z.string(), configurationPropertySchemaSchema)
        .optional(),
      patternProperties: z
        .record(z.string(), configurationPropertySchemaSchema)
        .optional(),
      additionalProperties: z
        .union([z.boolean(), configurationPropertySchemaSchema])
        .optional(),
      items: z
        .union([
          configurationPropertySchemaSchema,
          z.array(configurationPropertySchemaSchema).readonly(),
        ])
        .optional(),
      oneOf: z.array(configurationPropertySchemaSchema).readonly().optional(),
      anyOf: z.array(configurationPropertySchemaSchema).readonly().optional(),
      allOf: z.array(configurationPropertySchemaSchema).readonly().optional(),
      not: configurationPropertySchemaSchema.optional(),

      // Unsupported by policy (self-contained schemas only)
      $ref: z.never().optional(),
      $defs: z.never().optional(),

      "x-weaver": weaverPropertyExtensionsSchema.optional(),
    }),
  );

export const objectConfigurationPropertySchemaSchema: z.ZodType<ObjectConfigurationPropertySchema> =
  configurationPropertySchemaSchema.and(
    z.object({ type: z.literal("object") }),
  );
