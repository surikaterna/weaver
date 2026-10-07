import { isReservedPathSegment } from "@weaver-conf/config-types";
import { z } from "zod";
import { copySnapshotData } from "./descriptor-copy";
import { isPlainObject } from "./own-data";

// Admission is descriptor-first; a parsed DTO is never an engine-issued handle.
function guarded<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => copySnapshotData(value), schema);
}

// A record parser would discard own __proto__ data. Keep the captured body intact.
const dataRecordSchema =
  z.custom<Readonly<Record<string, unknown>>>(isPlainObject);
const literalPathSchema = z.array(z.string()).readonly();
const requestPathSchema = z
  .array(
    z
      .string()
      .refine(
        (value) => !isReservedPathSegment(value),
        "Reserved path segment",
      ),
  )
  .readonly();
const originSchema = z.strictObject({
  layer: z.string().min(1),
  providerId: z.string().min(1),
  rank: z.number().finite(),
  sourcePath: z.array(z.string().min(1)).min(1).readonly().optional(),
});
const layerSchema = originSchema
  .extend({
    entries: dataRecordSchema,
    trustedEmergency: z.boolean().optional(),
    merge: z.unknown().optional(),
  })
  .readonly();
const ceilingSchema = z
  .strictObject({
    path: requestPathSchema,
    maxRank: z.number().finite(),
  })
  .readonly();
const contributionSchema = z
  .strictObject({
    origin: originSchema.readonly(),
    present: z.boolean(),
    value: z.unknown(),
  })
  .readonly();

export const resolutionPathSchema = guarded(literalPathSchema);
export const resolutionOriginSchema = guarded(originSchema.readonly());
export type ResolutionOrigin = z.infer<typeof resolutionOriginSchema>;
export const resolutionLayerSchema = guarded(layerSchema);
export type ResolutionLayer = z.infer<typeof resolutionLayerSchema>;
export const resolutionCeilingSchema = guarded(ceilingSchema);
export type ResolutionCeiling = z.infer<typeof resolutionCeilingSchema>;
export const resolutionSnapshotInputSchema = guarded(
  z
    .strictObject({
      layers: z.array(layerSchema).readonly(),
      configuredRanks: z.array(z.number().finite()).min(1).readonly(),
      ceilings: z.array(ceilingSchema).readonly(),
    })
    .readonly(),
);
export type ResolutionSnapshotInput = z.infer<
  typeof resolutionSnapshotInputSchema
>;
export const resolutionContributionSchema = guarded(contributionSchema);
export type ResolutionContribution = z.infer<
  typeof resolutionContributionSchema
>;
export const configurationSnapshotSchema = guarded(
  z
    .strictObject({
      entries: dataRecordSchema,
      layers: z.array(layerSchema).readonly(),
    })
    .readonly(),
);
export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;
export const resolvedPathInspectionSchema = guarded(
  z
    .strictObject({
      path: literalPathSchema,
      present: z.boolean(),
      effectiveValue: z.unknown(),
      effectiveLayer: z.string().optional(),
      effectiveProviderId: z.string().optional(),
      effectiveSourcePath: z
        .array(z.string().min(1))
        .min(1)
        .readonly()
        .optional(),
      contributions: z.array(contributionSchema).readonly(),
    })
    .readonly(),
);
export type ResolvedPathInspection = z.infer<
  typeof resolvedPathInspectionSchema
>;
