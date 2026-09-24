import { z } from "zod";
import type {
  SchemaValidationError,
  SchemaValidationErrorCode,
  SchemaValidationPathSegment,
  SchemaValidationResult,
} from "./support";

export const schemaValidationPathSegmentSchema: z.ZodType<SchemaValidationPathSegment> =
  z.union([z.string(), z.number().finite()]);

export const schemaValidationErrorCodeSchema: z.ZodType<SchemaValidationErrorCode> =
  z.enum([
    "invalid-type",
    "invalid-value",
    "missing-required",
    "unknown-property",
    "invalid-path",
    "invalid-schema",
  ]);

export const schemaValidationErrorSchema: z.ZodType<SchemaValidationError> =
  z.strictObject({
    code: schemaValidationErrorCodeSchema,
    path: z.string(),
    segments: z.array(schemaValidationPathSegmentSchema).readonly(),
    message: z.string(),
    expected: z.string().optional(),
    actual: z.string().optional(),
  });

export const schemaValidationResultSchema: z.ZodType<SchemaValidationResult> =
  z.strictObject({
    valid: z.boolean(),
    errors: z.array(schemaValidationErrorSchema).readonly(),
  });
