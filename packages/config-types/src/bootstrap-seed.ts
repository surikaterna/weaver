import { z } from "zod";
import { environmentNameSchema } from "./environment";
import {
  credentialReferenceSchema,
  internalIdSchema,
} from "./internal-identities";
import { internalInfrastructureGenerationSchema } from "./internal-infrastructure";
import { internalScopeInventorySchema } from "./internal-state";
import { providerRevisionSchema } from "./provider-authority";
import {
  fragmentSchemaRegistrationRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "./schemas-schema-registration";

const absolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith("/") && !value.includes("\0"),
    "Expected an absolute local POSIX path",
  );
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").includes("..") &&
      !value.includes("\0"),
    "Expected a checkout-relative path",
  );
export const bootstrapStoreSchema = z.discriminatedUnion("factory", [
  z.strictObject({
    factory: z.literal("fs"),
    locator: z.strictObject({ filePath: absolutePath }),
  }),
  z.strictObject({
    factory: z.literal("mongodb"),
    locator: z.strictObject({
      connectionRef: credentialReferenceSchema,
      database: internalIdSchema,
      collection: internalIdSchema,
      storeId: z.string().min(1),
    }),
  }),
  z.strictObject({
    factory: z.literal("git"),
    locator: z.strictObject({
      localPath: absolutePath,
      filePath: relativePath,
      remote: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        })
        .optional(),
      branch: internalIdSchema.optional(),
    }),
    credentialRefs: z
      .strictObject({ token: credentialReferenceSchema })
      .optional(),
  }),
]);
export const bootstrapSeedSchema = z.strictObject({
  version: z.literal(1),
  environment: environmentNameSchema,
  store: bootstrapStoreSchema,
  trust: z.strictObject({ adminCredentialRef: credentialReferenceSchema }),
});
export type BootstrapSeed = z.infer<typeof bootstrapSeedSchema>;
export const initializeWeaverRequestSchema = z.strictObject({
  generationId: internalIdSchema.default("initial"),
  generation: internalInfrastructureGenerationSchema,
  registrations: z
    .array(
      z.union([
        serviceSchemaRegistrationRequestSchema,
        fragmentSchemaRegistrationRequestSchema,
      ]),
    )
    .default([]),
  scopeInventory: internalScopeInventorySchema,
});
export type InitializeWeaverRequest = z.infer<
  typeof initializeWeaverRequestSchema
>;
export const weaverRuntimeStateSchema = z.enum([
  "starting",
  "ready",
  "maintenance",
  "restart_required",
  "failed",
  "closed",
]);
export type WeaverRuntimeState = z.infer<typeof weaverRuntimeStateSchema>;
export const weaverRuntimeStatusSchema = z.strictObject({
  state: weaverRuntimeStateSchema,
  environment: environmentNameSchema,
  revision: z.string(),
  activeGeneration: internalIdSchema.optional(),
});
export type WeaverRuntimeStatus = z.infer<typeof weaverRuntimeStatusSchema>;
export const weaverInspectionSchema = z.strictObject({
  state: z.enum(["maintenance", "configured"]),
  environment: environmentNameSchema,
  activeGeneration: internalIdSchema,
  initialization: z.enum(["initializing", "initialized"]),
  controlRevision: providerRevisionSchema,
});
export type WeaverInspection = z.infer<typeof weaverInspectionSchema>;
