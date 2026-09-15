import { z } from "zod";
import { environmentNameSchema } from "./environment";

export const authoritySequenceSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const providerRevisionSchema = z.strictObject({
  storeId: z.string().min(1),
  environment: environmentNameSchema,
  layer: z.string().min(1),
  epoch: z.uuid(),
  sequence: authoritySequenceSchema,
});
export type ProviderRevision = z.infer<typeof providerRevisionSchema>;
export const providerMutationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("set"),
    key: z.string().min(1),
    value: z.json(),
  }),
  z.strictObject({ action: z.literal("remove"), key: z.string().min(1) }),
]);
export type ProviderMutation = z.infer<typeof providerMutationSchema>;
export const layerCommitRequestSchema = z.strictObject({
  layer: z.string().min(1),
  expectedRevision: providerRevisionSchema,
  operationId: z.uuid(),
  mutation: providerMutationSchema,
});
export type LayerCommitRequest = z.infer<typeof layerCommitRequestSchema>;
export const layerCommitReceiptSchema = z.strictObject({
  operationId: z.uuid(),
  previousRevision: providerRevisionSchema,
  revision: providerRevisionSchema,
  mutationDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const layerEnvelopeSchema = z.strictObject({
  storageFormat: z.literal(1),
  ...providerRevisionSchema.shape,
  entries: z.record(z.string(), z.json()),
  lastCommit: layerCommitReceiptSchema.optional(),
});
export type LayerEnvelope = z.infer<typeof layerEnvelopeSchema>;
export const mongoLayerEnvelopeSchema = layerEnvelopeSchema.extend({
  owner: z.uuid().nullable(),
  fence: authoritySequenceSchema,
});
export type MongoLayerEnvelope = z.infer<typeof mongoLayerEnvelopeSchema>;
export const layerCommitResultSchema = z.discriminatedUnion("success", [
  z.strictObject({
    success: z.literal(true),
    acknowledgement: z.enum(["durable", "volatile"]),
    snapshot: layerEnvelopeSchema,
  }),
  z.strictObject({
    success: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
export type LayerCommitResult = z.infer<typeof layerCommitResultSchema>;

const exclusiveFields = {
  namespace: z.string().min(1),
  maxEnvelopeBytes: z.number().int().positive(),
  scopedIO: z.literal("complete"),
};
export const providerCapabilitiesSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("durable-exclusive"),
    durability: z.enum(["local-fsync", "mongo-journal"]),
    ...exclusiveFields,
  }),
  z.strictObject({
    kind: z.literal("volatile-exclusive"),
    durability: z.literal("memory"),
    ...exclusiveFields,
  }),
  z.strictObject({
    kind: z.literal("immutable-input"),
    identity: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.string().min(1) }),
]);
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
export const providerInventorySchema = z.strictObject({
  complete: z.literal(true),
  revisions: z.array(providerRevisionSchema),
});
export type ProviderInventory = z.infer<typeof providerInventorySchema>;
export const providerPreflightSchema = z.strictObject({
  namespace: z.string().min(1),
  layers: z.array(z.string().min(1)),
  initialization: z.enum(["fresh", "existing", "volatile"]),
});
export type ProviderPreflight = z.infer<typeof providerPreflightSchema>;
export const providerOwnershipSchema = z.strictObject({
  namespace: z.string().min(1),
  owner: z.uuid(),
  layers: z.array(
    z.strictObject({
      layer: z.string().min(1),
      fence: authoritySequenceSchema,
      previousFence: authoritySequenceSchema,
      phase: z.enum(["acquiring", "owned", "releasing"]),
      observed: z.enum(["owned", "released", "not-applied", "lost", "unknown"]),
    }),
  ),
});
export type ProviderOwnership = z.infer<typeof providerOwnershipSchema>;
export const storageAuthorityOptionsSchema = z.strictObject({
  initialize: z.boolean().optional(),
  layers: z.array(z.string().min(1)).readonly().optional(),
});
export type StorageAuthorityOptions = z.infer<
  typeof storageAuthorityOptionsSchema
>;
export const fileAuthorityOptionsSchema = storageAuthorityOptionsSchema.extend({
  environment: environmentNameSchema,
});
export type FileAuthorityOptions = z.infer<typeof fileAuthorityOptionsSchema>;

/** Executable boundary. Handles are reference-identity capabilities, never serialized. */
export interface ProviderWriterHandle {
  readonly ownerId: string;
}
export interface ProviderAuthority {
  readonly capabilities: ProviderCapabilities;
  /** Read-only feasibility/discovery before any provider in the composition initializes. */
  preflight(layers?: readonly string[]): Promise<ProviderPreflight>;
  /** Mongo-only controlled recovery of this instance's retained conditional fences. */
  inspectOwnership?(): Promise<ProviderOwnership>;
  releaseQuarantinedWriter?(): Promise<void>;
  acquireWriter(ownerId: string): Promise<ProviderWriterHandle>;
  releaseWriter(handle: ProviderWriterHandle): Promise<void>;
  readLayer(layer: string): Promise<LayerEnvelope>;
  inventory(): Promise<ProviderInventory>;
  commitLayer(
    request: LayerCommitRequest,
    handle: ProviderWriterHandle,
  ): Promise<LayerCommitResult>;
}
