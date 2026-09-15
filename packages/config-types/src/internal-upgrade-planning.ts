import { z } from "zod";
import { environmentNameSchema } from "./environment";
import {
  builtinCatalogReferenceSchema,
  internalCatalogSchema,
} from "./internal-config";
import { internalDigestSchema, internalIdSchema } from "./internal-identities";
import { internalInfrastructureGenerationSchema } from "./internal-infrastructure";
import { internalScopeInventorySchema } from "./internal-state";
import {
  internalUpgradeDestinationSchema,
  internalUpgradePlanResultSchema,
} from "./internal-upgrade-plan";
import {
  providerCapabilitiesSchema,
  providerRevisionSchema,
} from "./provider-authority";
import { registeredConfigurationSchemaSchema } from "./schemas-registration-grammar";

export const internalUpgradeDispositionSchema = z.strictObject({
  path: z.string().min(1),
  action: z.enum(["reject", "transform", "reset"]),
  reason: z.string().min(1),
});

export const internalUpgradePlanRequestSchema = z.strictObject({
  version: z.literal(1),
  expectedAuthorityRevision: z.string().min(1),
  sourceCatalogDigest: internalDigestSchema,
  inventoryRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  infrastructureGeneration: internalIdSchema,
  target: internalUpgradeDestinationSchema.extend({
    registrations: internalCatalogSchema.shape.registrations,
  }),
  dispositions: z.array(internalUpgradeDispositionSchema).readonly().optional(),
});
export type InternalUpgradePlanRequest = z.infer<
  typeof internalUpgradePlanRequestSchema
>;

export const internalUpgradeSchemaBindingSchema = z
  .strictObject({
    path: z.string().regex(/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
    environment: environmentNameSchema,
    source: registeredConfigurationSchemaSchema.optional(),
    target: registeredConfigurationSchemaSchema.optional(),
  })
  .refine((value) => value.source !== undefined || value.target !== undefined, {
    message: "Schema binding requires a source or target",
  });

export const internalUpgradeLayerSnapshotSchema = z.strictObject({
  revision: providerRevisionSchema,
  entries: z.record(z.string(), z.json()),
});

export const internalUpgradeProviderBindingSchema = z
  .strictObject({
    providerId: internalIdSchema,
    namespace: z.string().min(1),
    writable: z.boolean(),
    capabilities: providerCapabilitiesSchema,
    layers: z.array(internalUpgradeLayerSnapshotSchema).min(1).readonly(),
  })
  .superRefine((provider, context) => {
    if (
      !("namespace" in provider.capabilities) ||
      provider.namespace !== provider.capabilities.namespace
    )
      context.addIssue({
        code: "custom",
        message: "Provider namespace does not match its authority capability",
      });
  });

export const internalUpgradePlannerInputSchema = z.strictObject({
  version: z.literal(1),
  request: internalUpgradePlanRequestSchema,
  authorityRevision: z.string().min(1),
  sourceCatalog: internalCatalogSchema,
  sourceCatalogDigest: internalDigestSchema,
  targetCatalog: internalCatalogSchema,
  targetCatalogDigest: internalDigestSchema,
  schemas: z.array(internalUpgradeSchemaBindingSchema).readonly(),
  inventory: internalScopeInventorySchema,
  infrastructureGenerationId: internalIdSchema,
  infrastructure: internalInfrastructureGenerationSchema,
  providers: z.array(internalUpgradeProviderBindingSchema).min(1).readonly(),
});
export type InternalUpgradePlannerInput = z.infer<
  typeof internalUpgradePlannerInputSchema
>;

export const internalUpgradePlanResponseSchema = z.strictObject({
  version: z.literal(1),
  authorityRevision: z.string().min(1),
  result: internalUpgradePlanResultSchema,
});
export type InternalUpgradePlanResponse = z.infer<
  typeof internalUpgradePlanResponseSchema
>;

export const internalUpgradeBuiltinTargetSchema = z.strictObject({
  builtinCatalog: builtinCatalogReferenceSchema,
});
