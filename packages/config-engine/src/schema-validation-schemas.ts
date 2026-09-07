import { z } from "zod";

export const schemaValidationPathSegmentSchema = z.union([
  z.string(),
  z.number().finite(),
]);

export const schemaValidationErrorCodeSchema = z.enum([
  "invalid-type",
  "invalid-value",
  "missing-required",
  "unknown-property",
  "invalid-path",
  "invalid-schema",
]);

export const schemaValidationErrorSchema = z.strictObject({
  code: schemaValidationErrorCodeSchema,
  path: z.string(),
  segments: z.array(schemaValidationPathSegmentSchema).readonly(),
  message: z.string(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});

export const schemaValidationResultSchema = z.strictObject({
  valid: z.boolean(),
  errors: z.array(schemaValidationErrorSchema),
});
