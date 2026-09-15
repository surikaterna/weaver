import { z } from "zod";
import { environmentNameSchema } from "./environment";
import {
  encodeInternalIdentity,
  internalDigestSchema,
  internalIdSchema,
  internalRecordIdSchema,
} from "./internal-identities";
import {
  fragmentSchemaRegistrationRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "./schemas-schema-registration";

export const builtinCatalogReferenceSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
  digest: internalDigestSchema,
});
export type BuiltinCatalogReference = z.infer<
  typeof builtinCatalogReferenceSchema
>;

export const internalFormatSchema = z.strictObject({
  version: z.literal(1),
  storeId: z.string().min(1),
  environment: environmentNameSchema,
  initialization: z.enum(["uninitialized", "initializing", "initialized"]),
  initializationIntent: z
    .strictObject({
      seedDigest: internalDigestSchema,
      inputDigest: internalDigestSchema,
      generationId: internalIdSchema,
    })
    .optional(),
  builtinCatalog: builtinCatalogReferenceSchema,
});
export type InternalFormat = z.infer<typeof internalFormatSchema>;
export const internalCatalogBindingSchema = z.strictObject({
  storeId: z.string().min(1),
  environment: environmentNameSchema,
});
export type InternalCatalogBinding = z.infer<
  typeof internalCatalogBindingSchema
>;

export const internalRegistrationAuditSchema = z.strictObject({
  actor: z.string().min(1),
  subject: z.string().min(1).optional(),
});
export const internalRegistrationRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("service"),
    request: serviceSchemaRegistrationRequestSchema,
    audit: internalRegistrationAuditSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("fragment"),
    request: fragmentSchemaRegistrationRequestSchema,
    audit: internalRegistrationAuditSchema,
  }),
]);
export type InternalRegistrationRecord = z.infer<
  typeof internalRegistrationRecordSchema
>;

export function internalRegistrationId(
  record: InternalRegistrationRecord,
): string {
  const { request } = record;
  return encodeInternalIdentity([
    request.environment,
    record.kind,
    request.serviceId,
    "slotPath" in request ? request.slotPath : "",
    "providerId" in request ? request.providerId : "",
  ]);
}

export const internalCatalogSchema = z
  .strictObject({
    registrations: z.record(
      internalRecordIdSchema,
      internalRegistrationRecordSchema,
    ),
  })
  .superRefine((catalog, context) => {
    for (const [id, record] of Object.entries(catalog.registrations)) {
      if (id !== internalRegistrationId(record))
        context.addIssue({
          code: "custom",
          path: ["registrations", id],
          message: "Registration record identity mismatch",
        });
    }
  });
export type InternalCatalog = z.infer<typeof internalCatalogSchema>;
