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
export const authorityLeafResponseSchema = z.strictObject({
  key: z.string(),
  value: z
    .union([z.string(), z.number().finite(), z.boolean(), z.null()])
    .optional(),
});
