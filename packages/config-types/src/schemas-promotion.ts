// Zod schemas for promotion pipeline, audit, and emergency override types

import { z } from "zod";
import { scopeInstanceSchema } from "./schemas-layers";

export const promotionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "applied",
  "expired",
]);

export const promotionRequestSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  fromValue: z.unknown(),
  toValue: z.unknown(),
  layer: z.string(),
  scopePath: z.array(scopeInstanceSchema).optional(),
  requestedBy: z.string(),
  requestedAt: z.string(),
  status: promotionStatusSchema,
  changePolicy: z.string(),
  reason: z.string().optional(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().optional(),
});

export const configDomainAuditEntrySchema = z.strictObject({
  domain: z.literal("config"),
  timestamp: z.string(),
  actor: z.string(),
  action: z.enum([
    "set",
    "remove",
    "install",
    "uninstall",
    "enable",
    "disable",
    "promote",
  ]),
  key: z.string(),
  layer: z.string(),
  scopePath: z.array(scopeInstanceSchema).optional(),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  changePolicy: z.string().optional(),
  isEmergencyOverride: z.boolean(),
  overrideReason: z.string().optional(),
});

export const sinkDomainAuditEntrySchema = z.strictObject({
  domain: z.literal("sink"),
  timestamp: z.string(),
  actor: z.string(),
  action: z.enum([
    "set",
    "remove",
    "promote",
    "rollback",
    "override",
    "provision",
  ]),
  key: z.string(),
  layer: z.string(),
  environment: z.string(),
  scopePath: z.string().optional(),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  isEmergencyOverride: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const schemaAuditActionSchema = z.enum([
  "schema.register.service",
  "schema.register.fragment",
  "schema.write.object",
  "schema.patch.path",
  "schema.validate.effective",
]);

export const schemaOperationAuditMetadataSchema = z.strictObject({
  operation: schemaAuditActionSchema,
  subject: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  servicePath: z.string().min(1).optional(),
  canonicalSlotPath: z.string().min(1).optional(),
  fragmentPath: z.string().min(1).optional(),
  writePath: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
});

export const schemaDomainAuditEntrySchema = z.strictObject({
  domain: z.literal("schema"),
  timestamp: z.string(),
  actor: z.string(),
  action: schemaAuditActionSchema,
  key: z.string(),
  environment: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  metadata: schemaOperationAuditMetadataSchema,
});

export const sessionDomainAuditEntrySchema = z.strictObject({
  domain: z.literal("session"),
  timestamp: z.string(),
  actor: z.string(),
  action: z.enum(["activate", "deactivate", "extend", "expire"]),
  sessionId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const secretDomainAuditEntrySchema = z.strictObject({
  domain: z.literal("secret"),
  timestamp: z.string(),
  actor: z.string(),
  action: z.enum(["resolve", "store", "delete", "invalidate", "cache-hit"]),
  provider: z.string(),
  uri: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const configAuditEntrySchema = z.discriminatedUnion("domain", [
  configDomainAuditEntrySchema,
  sinkDomainAuditEntrySchema,
  schemaDomainAuditEntrySchema,
  sessionDomainAuditEntrySchema,
  secretDomainAuditEntrySchema,
]);

export const emergencyOverrideRecordSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  actor: z.string(),
  reason: z.string(),
  scopePath: z.array(scopeInstanceSchema).optional(),
  layer: z.string(),
  createdAt: z.string(),
  followUpDeadline: z.string(),
  regularizedAt: z.string().optional(),
  regularizedBy: z.string().optional(),
});
