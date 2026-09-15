import { z } from "zod";
import { weaverErrorSchema } from "./errors";
import { authoritySequenceSchema } from "./provider-authority";
import { scopeInstanceSchema } from "./schemas-layers";

export const scopeLifecycleRequestSchema = z
  .strictObject({
    scopePath: z.array(scopeInstanceSchema).min(1).optional(),
    scopeId: z.string().min(1).optional(),
    value: z.string().min(1).optional(),
    actor: z.string().min(1),
    expectedRevision: z.string().min(1).optional(),
    displayName: z.string().optional(),
    archive: z.literal(false).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.scopePath
        ? value.scopeId !== undefined || value.value !== undefined
        : !value.scopeId || !value.value
    )
      context.addIssue({
        code: "custom",
        message: "Supply one canonical scopePath or one scopeId/value pair",
      });
  });
export type ScopeLifecycleRequest = z.infer<typeof scopeLifecycleRequestSchema>;
export const scopeLifecycleResultSchema = z.strictObject({
  success: z.boolean(),
  scopePath: z.array(scopeInstanceSchema).optional(),
  scopeId: z.string().optional(),
  value: z.string().optional(),
  revision: z.string().optional(),
  inventoryRevision: authoritySequenceSchema.optional(),
  error: weaverErrorSchema.optional(),
});
export type ScopeLifecycleResult = z.infer<typeof scopeLifecycleResultSchema>;
