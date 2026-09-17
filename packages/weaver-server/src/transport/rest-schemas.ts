import {
  fragmentSchemaRegistrationRequestSchema,
  registeredEffectiveValidationRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";

/** PUT /v1/config/*keyPath body — value is required */
export const configWriteBodySchema = z
  .object({
    value: z.unknown(),
  })
  .passthrough()
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

/** PATCH /v1/config body — batch write with entries map */
export const configBatchBodySchema = z.object({
  entries: z.record(z.string(), z.unknown()),
});

/** POST /v1/admin/scopes/:scopeId body */
export const scopeProvisionBodySchema = z.object({
  value: z.string().min(1),
  displayName: z.string().optional(),
});

/** POST /v1/admin/schemas/services body */
export const serviceSchemaRegistrationBodySchema =
  serviceSchemaRegistrationRequestSchema;

/** POST /v1/admin/schemas/fragments body */
export const fragmentSchemaRegistrationBodySchema =
  fragmentSchemaRegistrationRequestSchema;

export const registeredObjectWriteBodySchema = z
  .strictObject({ value: z.unknown() })
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

export const registeredPathPatchBodySchema = z
  .strictObject({ value: z.unknown() })
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

export const registeredEffectiveValidationQuerySchema =
  registeredEffectiveValidationRequestSchema
    .pick({ environment: true, scope: true })
    .strict();
