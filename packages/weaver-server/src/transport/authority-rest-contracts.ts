import {
  configurationValueSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { z } from "zod";

export const authorityReadQuerySchema = z.strictObject({
  env: z.string().optional(),
  scope: z.string().optional(),
  inspect: z.literal("").optional(),
});
export const authorityWriteQuerySchema = z.strictObject({
  env: z.string().optional(),
  scope: z.string().optional(),
  layer: z.string().min(1),
});
export const authorityPutBodySchema = z
  .strictObject({ value: z.unknown() })
  .refine((body) => Object.hasOwn(body, "value"));
export const authorityDeleteBodySchema = z.strictObject({});
export const authorityValueResponseSchema = z.strictObject({
  key: z.string(),
  value: configurationValueSchema.optional(),
});

/** Wire materialization only: the authority withholds restricted arrays as a
 * whole before serialization; JSON only omits undefined object members here. */
export function authorityWireValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    const wire: unknown = JSON.parse(encoded);
    return wire;
  } catch {
    throw createWeaverError(
      "INTERNAL_ERROR",
      "Configuration response cannot be serialized",
    );
  }
}
