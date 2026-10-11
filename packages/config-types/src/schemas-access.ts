// schemas-access.ts — Zod schemas for access context and write policy types

import { z } from "zod";
import { scopeInstanceSchema } from "./schemas-layers";
import { configurationRoleSchema } from "./schemas-policy";
import { configurationPropertySchemaSchema } from "./schemas-property";

export const configurationAccessContextSchema = z.strictObject({
  userId: z.string(),
  roles: z.array(configurationRoleSchema).readonly(),
  assignedScopes: z.array(scopeInstanceSchema).readonly().optional(),
  trustedSession: z
    .strictObject({
      id: z.string().min(1),
      emergency: z.boolean(),
      reason: z.string(),
    })
    .readonly()
    .optional(),
});

export const layerWriteConstraintSchema = z.strictObject({
  scopeRestriction: z.enum(["own-scope", "own-user"]).optional(),
});

export const layerWritePolicySchema = z.strictObject({
  layer: z.string(),
  allowedRoles: z.array(configurationRoleSchema).readonly(),
  constraints: z.array(layerWriteConstraintSchema).readonly().optional(),
});

export const configurationSchemaFragmentSchema = z.strictObject({
  description: z.string(),
  schemaVersion: z.number().int().positive(),
  owner: z.string(),
  configuration: configurationPropertySchemaSchema,
});

export const serviceConfigurationDeclarationSchema = z.strictObject({
  serviceId: z.string(),
  description: z.string(),
  schemaVersion: z.number().int().positive(),
  owner: z.string(),
  namespaces: z.array(z.string()).readonly().optional(),
  configuration: configurationPropertySchemaSchema,
  reads: z.array(z.string()).readonly().optional(),
  fragments: z.record(z.string(), configurationSchemaFragmentSchema).optional(),
  instanceConfig: z
    .strictObject({
      instanceKey: z.string(),
      maxInstances: z.number().int().positive().optional(),
    })
    .optional(),
});

export const serviceAccessPolicySchema = z.strictObject({
  serviceId: z.string(),
  allowedNamespaces: z.array(z.string()).readonly(),
  allowedReads: z.array(z.string()).readonly(),
  allowedSecrets: z.boolean(),
  scopeAccess: z.union([z.literal("all"), z.array(z.string()).readonly()]),
  approvedBy: z.string(),
  approvedAt: z.string(),
  expiresAt: z.string().optional(),
});
