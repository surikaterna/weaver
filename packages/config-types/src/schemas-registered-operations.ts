import { z } from "zod";
import type { RegisteredSchemasResponse } from "./registered-operations";
import { configurationPropertySchemaSchema } from "./schemas-property";
import { writeResultSchema } from "./schemas-providers";
import { publicConfigPathSchema } from "./schemas-registration-paths";
import { schemaValidationResultSchema } from "./schemas-schema-validation";

const registeredWriteOptionsSchema = {
  layer: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  ifRevision: z.string().min(1).optional(),
};

export const registeredSchemasResponseSchema: z.ZodType<RegisteredSchemasResponse> =
  z.strictObject({
    schemas: z.record(z.string(), configurationPropertySchemaSchema),
  });

export const registeredObjectWriteRequestSchema = z
  .strictObject({
    anchorPath: publicConfigPathSchema,
    value: z.unknown(),
    ...registeredWriteOptionsSchema,
  })
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

export const registeredPathPatchRequestSchema = z
  .strictObject({
    path: publicConfigPathSchema,
    value: z.unknown(),
    ...registeredWriteOptionsSchema,
  })
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

export const registeredEffectiveValidationRequestSchema = z.strictObject({
  anchorPath: publicConfigPathSchema,
  environment: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

export const registeredObjectWriteResponseSchema = writeResultSchema;
export const registeredPathPatchResponseSchema = writeResultSchema;
export const registeredEffectiveValidationResponseSchema =
  schemaValidationResultSchema;
