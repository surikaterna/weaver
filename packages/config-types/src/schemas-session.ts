// schemas-session.ts — Zod schemas for session types

import { z } from "zod";

export const sessionTypeSchema = z.string();

export const sessionLayerMetadataSchema = z.strictObject({
  activatedBy: z.string(),
  activatedAt: z.number(),
  reason: z.string(),
  mode: sessionTypeSchema,
  expiresAt: z.number().optional(),
});

export const overrideSessionSchema = z.strictObject({
  id: z.string(),
  activatedAt: z.string(),
  expiresAt: z.string(),
  activatedBy: z.string(),
  reason: z.string(),
  isActive: z.boolean(),
  overrides: z.record(z.string(), z.unknown()),
});

export const sessionActivationRequestSchema = z.strictObject({
  reason: z.string().trim().min(1),
  durationMs: z.number().int().positive().max(2147483647).optional(),
  activatedBy: z.string().min(1).optional(),
});

export const sessionDeactivationResultSchema = z.strictObject({
  sessionId: z.string(),
  deactivatedAt: z.string(),
  overridesCleared: z.number(),
  auditRecorded: z.boolean(),
});
