import {
  createWeaverError,
  isReservedPathSegment,
} from "@weaver-conf/config-types";
import { z } from "zod";
import { copySnapshotData } from "./descriptor-copy";
import { isPlainObject } from "./merge-traversal";

// Preflight the whole graph before Zod reads fields; schema parsing grants no authority.
function guarded<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => copySnapshotData(value, true), schema);
}

function denseArray<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .transform((value, context) => {
      if (!Array.isArray(value)) {
        context.addIssue({
          code: "custom",
          message: "Resolution metadata must be an array",
        });
        return z.NEVER;
      }
      const result: z.output<T>[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !Object.hasOwn(descriptor, "value"))
          throw createWeaverError(
            "VALIDATION_ERROR",
            "Sparse structural arrays are not resolution metadata",
          );
        const child: unknown = descriptor.value;
        const parsed = schema.safeParse(child);
        if (!parsed.success) {
          context.addIssue({
            code: "custom",
            message: "Invalid resolution metadata element",
          });
          return z.NEVER;
        }
        Object.defineProperty(result, String(index), {
          value: parsed.data,
          enumerable: true,
        });
      }
      return result;
    })
    .readonly();
}

const dataValueSchema = z
  .unknown()
  .transform((value) => copySnapshotData(value));
const dataRecordSchema = dataValueSchema
  .transform((value, context) => {
    if (isPlainObject(value)) return value;
    context.addIssue({
      code: "custom",
      message: "Entries must be a plain record",
    });
    return z.NEVER;
  })
  .readonly();
const literalPathSchema = denseArray(z.string());
const requestPathSchema = denseArray(
  z
    .string()
    .refine((value) => !isReservedPathSegment(value), "Reserved path segment"),
);
const originShape = z.strictObject({
  layer: z.string().min(1),
  providerId: z.string().min(1),
  rank: z.number().finite(),
});

export const resolutionPathSchema = guarded(literalPathSchema);
export const resolutionOriginSchema = guarded(originShape.readonly());
export type ResolutionOrigin = z.infer<typeof resolutionOriginSchema>;

export const resolutionLayerSchema = guarded(
  originShape
    .extend({
      entries: dataRecordSchema,
      trustedEmergency: z.boolean().optional(),
      merge: z.unknown().optional(),
    })
    .readonly(),
);
export type ResolutionLayer = z.infer<typeof resolutionLayerSchema>;

export const resolutionCeilingSchema = guarded(
  z
    .strictObject({
      path: requestPathSchema,
      maxRank: z.number().finite(),
    })
    .readonly(),
);
export type ResolutionCeiling = z.infer<typeof resolutionCeilingSchema>;

export const resolutionSnapshotInputSchema = guarded(
  z
    .strictObject({
      layers: denseArray(resolutionLayerSchema),
      configuredRanks: denseArray(z.number().finite()).refine(
        (ranks) => ranks.length > 0,
      ),
      ceilings: denseArray(resolutionCeilingSchema),
    })
    .readonly(),
);
export type ResolutionSnapshotInput = z.infer<
  typeof resolutionSnapshotInputSchema
>;

export const resolutionTraceSchema = guarded(
  z
    .strictObject({
      path: literalPathSchema,
      origin: resolutionOriginSchema,
    })
    .readonly(),
);
export type ResolutionTrace = z.infer<typeof resolutionTraceSchema>;

export const resolutionContributionSchema = guarded(
  z
    .strictObject({
      origin: resolutionOriginSchema,
      present: z.boolean(),
      value: dataValueSchema,
    })
    .readonly(),
);
export type ResolutionContribution = z.infer<
  typeof resolutionContributionSchema
>;

export const configurationSnapshotSchema = guarded(
  z
    .strictObject({
      entries: dataRecordSchema,
      layers: denseArray(resolutionLayerSchema),
      trace: denseArray(resolutionTraceSchema),
    })
    .readonly(),
);
export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;

export const resolvedPathInspectionSchema = guarded(
  z
    .strictObject({
      path: literalPathSchema,
      present: z.boolean(),
      effectiveValue: dataValueSchema,
      effectiveLayer: z.string().optional(),
      effectiveProviderId: z.string().optional(),
      contributions: denseArray(resolutionContributionSchema),
    })
    .readonly(),
);
export type ResolvedPathInspection = z.infer<
  typeof resolvedPathInspectionSchema
>;
