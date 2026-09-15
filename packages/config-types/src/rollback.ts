import { z } from "zod";
import { environmentNameSchema } from "./environment";
import { publicConfigPathSchema } from "./schemas-registration-paths";

export const rollbackRequestSchema = z.strictObject({
  layer: z.string().min(1),
  environment: environmentNameSchema,
  anchorPath: publicConfigPathSchema,
  toRevision: z.string().min(1),
  expectedRevision: z.string().min(1),
  actor: z.string().min(1),
});
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;
