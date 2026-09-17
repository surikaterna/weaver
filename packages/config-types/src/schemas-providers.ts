import { z } from "zod";

// --- Write result and change schemas ---

export const writeResultSchema = z.strictObject({
  success: z.boolean(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  revision: z.string().optional(),
});

export const configurationChangeSchema = z.strictObject({
  key: z.string(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
});

// --- Conflict and sync schemas ---

export const configurationConflictSchema = z.strictObject({
  key: z.string(),
  localValue: z.unknown(),
  remoteValue: z.unknown(),
  localRevision: z.string(),
  remoteRevision: z.string(),
});

export const syncResultSchema = z.strictObject({
  pulled: z.number(),
  pushed: z.number(),
  conflicts: z.array(configurationConflictSchema),
});

export const syncQueueMetadataSchema = z.strictObject({
  pendingCount: z.number(),
  inFlightCount: z.number(),
  oldestQueuedAt: z.number().optional(),
  newestQueuedAt: z.number().optional(),
});

export const syncStatusSyncedSchema = z.strictObject({
  status: z.literal("synced"),
  lastSyncedAt: z.number(),
});

export const syncStatusSyncingSchema = z.strictObject({
  status: z.literal("syncing"),
});

export const syncStatusOfflineSchema = z.strictObject({
  status: z.literal("offline"),
  lastSyncedAt: z.number(),
  pendingWriteCount: z.number(),
});

export const syncStatusConflictSchema = z.strictObject({
  status: z.literal("conflict"),
  conflicts: z.array(configurationConflictSchema),
});

export const syncStatusErrorSchema = z.strictObject({
  status: z.literal("error"),
  error: z.string(),
  lastSyncedAt: z.number().optional(),
});

export const syncStatusSchema = z.discriminatedUnion("status", [
  syncStatusSyncedSchema,
  syncStatusSyncingSchema,
  syncStatusOfflineSchema,
  syncStatusConflictSchema,
  syncStatusErrorSchema,
]);

// --- Inspection schema ---

export const configurationInspectionSchema = z.strictObject({
  key: z.string(),
  effectiveValue: z.unknown().optional(),
  effectiveLayer: z.string().optional(),
  layerValues: z.record(z.string(), z.unknown()).optional(),
});
