import { z } from "zod";
import { weaverErrorSchema } from "./errors";
import { configurationPropertySchemaSchema } from "./schemas-property";

export const registrationOwnerSchema = z.strictObject({
  name: z.string().min(1),
  contact: z.string().min(1),
});

export const fragmentSlotDeclarationSchema = z.strictObject({
  slotPath: z.string().min(1),
  accepts: z.literal("object"),
});

export const schemaRegistrationAuditMetadataSchema = z.strictObject({
  subject: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

export const serviceSchemaRegistrationRequestSchema = z.strictObject({
  serviceId: z.string().min(1),
  environment: z.string().min(1),
  owner: registrationOwnerSchema,
  schema: configurationPropertySchemaSchema,
  schemaVersion: z.string().min(1).optional(),
  fragmentSlots: z.array(fragmentSlotDeclarationSchema).readonly(),
});

export const fragmentSchemaRegistrationRequestSchema = z.strictObject({
  serviceId: z.string().min(1),
  providerId: z.string().min(1),
  slotPath: z.string().min(1),
  environment: z.string().min(1),
  owner: registrationOwnerSchema,
  schema: configurationPropertySchemaSchema,
  schemaVersion: z.string().min(1).optional(),
});

export const fragmentSlotRegistrationMetadataSchema = z.strictObject({
  serviceId: z.string(),
  servicePath: z.string(),
  slotPath: z.string(),
  canonicalSlotPath: z.string(),
  environment: z.string(),
  providerId: z.string(),
  owner: registrationOwnerSchema,
  accepts: z.literal("object"),
  schemaVersion: z.string().optional(),
  audit: schemaRegistrationAuditMetadataSchema.optional(),
});

export const schemaRegistrationMetadataSchema = z.strictObject({
  serviceId: z.string(),
  servicePath: z.string(),
  environment: z.string(),
  providerId: z.string(),
  owner: registrationOwnerSchema,
  schemaVersion: z.string().optional(),
  canonicalSlotPath: z.string().optional(),
  fragmentPath: z.string().optional(),
  audit: schemaRegistrationAuditMetadataSchema.optional(),
});

export const schemaRegistrationResponseSchema = z.strictObject({
  success: z.boolean(),
  isNewSchema: z.boolean(),
  hasBreakingChanges: z.boolean(),
  metadata: schemaRegistrationMetadataSchema.optional(),
  breakingChanges: z.array(z.string()).readonly().optional(),
  error: weaverErrorSchema.optional(),
});
