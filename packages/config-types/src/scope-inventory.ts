import { z } from "zod";
import {
  authoritySequenceSchema,
  providerCapabilitiesSchema,
  providerInventorySchema,
} from "./provider-authority";
import { scopeInstanceSchema } from "./schemas-layers";

export const scopeInventorySchema = z.strictObject({
  version: z.literal(1),
  revision: authoritySequenceSchema,
  contexts: z.record(
    z.string().regex(/^[a-f0-9]+$/),
    z.strictObject({
      scopePath: z
        .array(
          scopeInstanceSchema.extend({
            scopeId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
            value: z.string().regex(/^[A-Za-z0-9._-]+$/),
          }),
        )
        .min(1),
      state: z.enum(["active", "retired"]),
      displayName: z.string().optional(),
    }),
  ),
});
export type ScopeInventory = z.infer<typeof scopeInventorySchema>;
export const authorityVectorSchema = z.strictObject({
  version: z.literal(1),
  infrastructureId: z.string().min(1),
  inventoryRevision: authoritySequenceSchema,
  inventoryDigest: z.string().min(1),
  layerOrder: z.array(z.string().min(1)),
  providers: z.array(
    z.strictObject({
      providerId: z.string().min(1),
      revisions: z.array(z.string().min(1)),
    }),
  ),
});
export type AuthorityVector = z.infer<typeof authorityVectorSchema>;
export const serviceAuthoritySnapshotSchema = z.strictObject({
  revision: z.string().min(1),
  inventory: scopeInventorySchema,
  providers: z.record(
    z.string(),
    z.strictObject({
      capabilities: providerCapabilitiesSchema,
      inventory: providerInventorySchema,
    }),
  ),
});
export type ServiceAuthoritySnapshot = z.infer<
  typeof serviceAuthoritySnapshotSchema
>;
