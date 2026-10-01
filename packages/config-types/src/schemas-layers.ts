// schemas-layers.ts — Zod schemas for layer and context types

import { z } from "zod";
import {
  hasDomainFields,
  isDomainRecord,
  ownDomainValue,
} from "./domain-capture";
import type { ScopeInstance } from "./types";

export const configurationLayerSchema = z.string();

export const scopeDefinitionSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  parentScopeId: z.string().optional(),
});

export const scopeInstanceSchema = z.strictObject({
  scopeId: z.string(),
  value: z.string(),
});

/** Field authority shared with identity captures; the legacy object schema stays intact. */
export function isScopeInstanceData(value: unknown): value is ScopeInstance {
  return (
    isDomainRecord(value) &&
    hasDomainFields(value, ["scopeId", "value"]) &&
    typeof ownDomainValue(value, "scopeId") === "string" &&
    typeof ownDomainValue(value, "value") === "string"
  );
}

export const scopeHierarchySchema = z.strictObject({
  scopes: z.array(scopeDefinitionSchema),
});

/** @deprecated Use `scopeHierarchySchema` instead. */
export const tenantScopeHierarchySchema = scopeHierarchySchema;

export const configurationContextSchema = z.strictObject({
  scopePath: z.array(scopeInstanceSchema),
  userId: z.string(),
  deviceId: z.string(),
});

export const configurationLayerEntrySchema = z.strictObject({
  layer: z.string(),
  entries: z.record(z.string(), z.unknown()),
});

export const configurationLayerStackSchema = z.strictObject({
  layers: z.array(configurationLayerEntrySchema),
});

export const configurationLayerDataSchema = z.strictObject({
  entries: z.record(z.string(), z.unknown()),
  revision: z.string().optional(),
  lastSyncedAt: z.number().optional(),
});
