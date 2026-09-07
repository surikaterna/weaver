import { z } from "zod";
import { weaverErrorSchema } from "./errors";
import { objectConfigurationPropertySchemaSchema } from "./schemas-property";
import {
  providerIdSchema,
  serviceIdSchema,
  slotPathSchema,
} from "./schemas-registration-paths";

export const registrationOwnerSchema = z.strictObject({
  name: z.string().min(1),
  contact: z.string().min(1),
});

export const fragmentSlotDeclarationSchema = z.strictObject({
  slotPath: slotPathSchema,
  accepts: z.literal("object"),
});

export const schemaRegistrationAuditMetadataSchema = z.object({
  actor: z.string().min(1).optional(),
});

export const serviceSchemaRegistrationRequestSchema = z
  .strictObject({
    serviceId: serviceIdSchema,
    environment: z.string().min(1),
    owner: registrationOwnerSchema,
    schema: objectConfigurationPropertySchemaSchema,
    schemaVersion: z.string().min(1).optional(),
    fragmentSlots: z.array(fragmentSlotDeclarationSchema).readonly(),
  })
  .superRefine((request, context) => {
    for (const [index, slot] of request.fragmentSlots.entries()) {
      if (slot.slotPath.slice(1).split("/")[0] === request.serviceId) {
        context.addIssue({
          code: "custom",
          message: "slotPath must be service-relative",
          path: ["fragmentSlots", index, "slotPath"],
        });
      }
    }
  });

export const fragmentSchemaRegistrationRequestSchema = z
  .strictObject({
    serviceId: serviceIdSchema,
    providerId: providerIdSchema,
    slotPath: slotPathSchema,
    environment: z.string().min(1),
    owner: registrationOwnerSchema,
    schema: objectConfigurationPropertySchemaSchema,
    schemaVersion: z.string().min(1).optional(),
  })
  .refine(
    (request) => request.slotPath.slice(1).split("/")[0] !== request.serviceId,
    { message: "slotPath must be service-relative", path: ["slotPath"] },
  );

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
