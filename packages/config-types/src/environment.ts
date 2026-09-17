// Canonical environment identity shared by configuration contracts.

import { z } from "zod";

/** Identifies a deployment environment */
export const environmentNamePattern =
  /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const environmentNameSchema = z
  .string()
  .regex(
    environmentNamePattern,
    "Environment must be a safe identifier containing only letters, numbers, dots, underscores, and hyphens",
  );

export type EnvironmentName = z.infer<typeof environmentNameSchema>;
