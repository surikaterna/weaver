import { z } from "zod";

export const resolutionPathSchema = z.array(z.string()).readonly();
export const resolutionOriginSchema = z
  .strictObject({
    layer: z.string().min(1),
    providerId: z.string().min(1),
    rank: z.number().finite(),
  })
  .readonly();
export type ResolutionOrigin = z.infer<typeof resolutionOriginSchema>;

export const resolutionLayerSchema = resolutionOriginSchema
  .unwrap()
  .extend({
    entries: z.record(z.string(), z.unknown()).readonly(),
    trustedEmergency: z.boolean().optional(),
    merge: z.unknown().optional(),
  })
  .readonly();
export type ResolutionLayer = z.infer<typeof resolutionLayerSchema>;

export const resolutionCeilingSchema = z
  .strictObject({
    path: resolutionPathSchema,
    maxRank: z.number().finite(),
  })
  .readonly();
export type ResolutionCeiling = z.infer<typeof resolutionCeilingSchema>;

export const resolutionSnapshotInputSchema = z
  .strictObject({
    layers: z.array(resolutionLayerSchema).readonly(),
    configuredRanks: z.array(z.number().finite()).min(1).readonly(),
    ceilings: z.array(resolutionCeilingSchema).readonly(),
  })
  .readonly();
export type ResolutionSnapshotInput = z.infer<
  typeof resolutionSnapshotInputSchema
>;

export const resolutionTraceSchema = z
  .strictObject({
    path: resolutionPathSchema,
    origin: resolutionOriginSchema,
  })
  .readonly();
export type ResolutionTrace = z.infer<typeof resolutionTraceSchema>;

export const resolutionContributionSchema = z
  .strictObject({
    origin: resolutionOriginSchema,
    present: z.boolean(),
    value: z.unknown(),
  })
  .readonly();
export type ResolutionContribution = z.infer<
  typeof resolutionContributionSchema
>;

export const configurationSnapshotSchema = z
  .strictObject({
    entries: z.record(z.string(), z.unknown()).readonly(),
    layers: z.array(resolutionLayerSchema).readonly(),
    trace: z.array(resolutionTraceSchema).readonly(),
  })
  .readonly();
export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;

export const resolvedPathInspectionSchema = z
  .strictObject({
    path: resolutionPathSchema,
    present: z.boolean(),
    effectiveValue: z.unknown(),
    effectiveLayer: z.string().optional(),
    effectiveProviderId: z.string().optional(),
    contributions: z.array(resolutionContributionSchema).readonly(),
  })
  .readonly();
export type ResolvedPathInspection = z.infer<
  typeof resolvedPathInspectionSchema
>;
