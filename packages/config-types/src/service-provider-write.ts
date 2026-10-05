import { z } from "zod";
import { serviceDataBoundary } from "./service-data-boundary";

/** Trusted adapter declarations; dispatch requires separate host authority opt-in. */
export const configurationProviderWriteBindingSchema = serviceDataBoundary(
  z
    .strictObject({
      providerId: z.string().min(1),
      operation: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("write") }).readonly(),
        z
          .strictObject({
            kind: z.literal("write-layer"),
            layer: z.string().min(1),
          })
          .readonly(),
      ]),
      flush: z.enum(["required", "none"]),
      failureSemantics: z.enum(["rejected-means-no-effect", "unknown"]),
    })
    .readonly(),
);
export type ConfigurationProviderWriteBinding = z.infer<
  typeof configurationProviderWriteBindingSchema
>;
