import type { z } from "zod";
import type {
  canonicalConfigurationPathSchema,
  relativeConfigurationPathSchema,
} from "./schemas-service-paths";

export type CanonicalConfigurationPath = z.infer<
  typeof canonicalConfigurationPathSchema
>;
export type RelativeConfigurationPath = z.infer<
  typeof relativeConfigurationPathSchema
>;
