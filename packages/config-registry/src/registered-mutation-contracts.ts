import { configurationPropertySchemaSchema } from "@weaver-conf/config-types";
import { z } from "zod";

/** Same applicable metadata as public projection, without declassifying writes. */
export const registeredMutationEvidenceSchema = z
  .strictObject({
    schemas: z.array(configurationPropertySchemaSchema).readonly(),
    ancestors: z.array(configurationPropertySchemaSchema).readonly(),
    declared: z.boolean(),
    unconstrained: z.boolean(),
    ambiguous: z.boolean(),
    sensitive: z.boolean(),
    forbidden: z.boolean(),
    reference: z.boolean(),
    containers: z.array(z.enum(["object", "array"])).readonly(),
  })
  .readonly();

export type RegisteredMutationEvidence = z.infer<
  typeof registeredMutationEvidenceSchema
>;

export const registeredMutationFootprintSchema = z
  .array(
    z
      .strictObject({
        path: z.array(z.string()).readonly(),
        before: registeredMutationEvidenceSchema,
        after: registeredMutationEvidenceSchema,
      })
      .readonly(),
  )
  .readonly();
export type RegisteredMutationFootprint = z.infer<
  typeof registeredMutationFootprintSchema
>;
