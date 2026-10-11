// schemas-policy.ts — Zod schemas for change policy, visibility, and role types

import { z } from "zod";

export const configChangePolicySchema = z.enum([
  "full-pipeline",
  "staging-gate",
  "direct-allowed",
  "emergency-override",
]);

export const configurationVisibilitySchema = z.enum([
  "public",
  "admin",
  "platform",
  "internal",
]);

export const configurationRoleSchema = z.string();

export const configReloadBehaviorSchema = z.enum([
  "hot",
  "restart-required",
  "rolling-restart",
]);

export const configurationJsonSchemaTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

export const propertySessionModeSchema = z.enum([
  "allowed",
  "restricted",
  "blocked",
]);

export const weaverPropertyExtensionsSchema = z.strictObject({
  sensitive: z.boolean().optional(),
  visibility: configurationVisibilitySchema.optional(),
  changePolicy: configChangePolicySchema.optional(),
  reloadBehavior: configReloadBehaviorSchema.optional(),
  expressionAllowed: z.boolean().optional(),
  maxOverrideLayer: z.string().min(1).optional(),
  writeRestriction: z.array(configurationRoleSchema).readonly().optional(),
  sessionMode: propertySessionModeSchema.optional(),
});
