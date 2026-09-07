import type { ScopeInstance } from "./types";

// Promotion pipeline, audit, and emergency override types for Iteration 5

export type PromotionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "expired";

export interface PromotionRequest {
  readonly id: string;
  readonly key: string;
  readonly fromValue: unknown;
  readonly toValue: unknown;
  readonly layer: string;
  readonly scopePath?: readonly ScopeInstance[] | undefined;
  readonly requestedBy: string;
  readonly requestedAt: string; // ISO timestamp
  readonly status: PromotionStatus;
  readonly changePolicy: string;
  readonly reason?: string | undefined;
  readonly reviewedBy?: string | undefined;
  readonly reviewedAt?: string | undefined;
}

/** Base fields shared by all audit entry variants */
export interface AuditEntryBase {
  readonly timestamp: string; // ISO
  readonly actor: string;
}

/** Config-domain audit entry (promotion pipeline, layer writes) */
export interface ConfigDomainAuditEntry extends AuditEntryBase {
  readonly domain: "config";
  readonly action:
    | "set"
    | "remove"
    | "install"
    | "uninstall"
    | "enable"
    | "disable"
    | "promote";
  readonly key: string;
  readonly layer: string;
  readonly scopePath?: readonly ScopeInstance[] | undefined;
  readonly oldValue?: unknown | undefined;
  readonly newValue?: unknown | undefined;
  readonly changePolicy?: string | undefined;
  readonly isEmergencyOverride: boolean;
  readonly overrideReason?: string | undefined;
}

/** Sink-domain audit entry (dispatcher pipeline with environment context) */
export interface SinkDomainAuditEntry extends AuditEntryBase {
  readonly domain: "sink";
  readonly action:
    | "set"
    | "remove"
    | "promote"
    | "rollback"
    | "override"
    | "provision";
  readonly key: string;
  readonly layer: string;
  readonly environment: string;
  readonly scopePath?: string | undefined;
  readonly oldValue?: unknown | undefined;
  readonly newValue?: unknown | undefined;
  readonly isEmergencyOverride: boolean;
  readonly metadata?: Record<string, unknown> | undefined;
}

export type SchemaAuditAction =
  | "schema.register.service"
  | "schema.register.fragment"
  | "schema.write.object"
  | "schema.patch.path"
  | "schema.validate.effective";

export interface SchemaOperationAuditMetadata {
  readonly operation: SchemaAuditAction;
  readonly subject?: string | undefined;
  readonly serviceId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly servicePath?: string | undefined;
  readonly canonicalSlotPath?: string | undefined;
  readonly fragmentPath?: string | undefined;
  readonly writePath?: string | undefined;
  readonly environment?: string | undefined;
}

export interface SchemaDomainAuditEntry extends AuditEntryBase {
  readonly domain: "schema";
  readonly action: SchemaAuditAction;
  readonly key: string;
  readonly environment: string;
  readonly success: boolean;
  readonly error?: string | undefined;
  readonly metadata: SchemaOperationAuditMetadata;
}

/** Session-domain audit entry (override session lifecycle) */
export interface SessionDomainAuditEntry extends AuditEntryBase {
  readonly domain: "session";
  readonly action: "activate" | "deactivate" | "extend" | "expire";
  readonly sessionId: string;
  readonly details?: Record<string, unknown> | undefined;
}

/** Secret-domain audit entry (secret resolution and caching) */
export interface SecretDomainAuditEntry extends AuditEntryBase {
  readonly domain: "secret";
  readonly action: "resolve" | "store" | "delete" | "invalidate" | "cache-hit";
  readonly provider: string;
  readonly uri: string;
  readonly success: boolean;
  readonly error?: string | undefined;
}

/**
 * Unified audit entry — discriminated union on `domain`.
 * Single source of truth for all audit events across Weaver.
 */
export type ConfigAuditEntry =
  | ConfigDomainAuditEntry
  | SinkDomainAuditEntry
  | SchemaDomainAuditEntry
  | SessionDomainAuditEntry
  | SecretDomainAuditEntry;

export interface EmergencyOverrideRecord {
  readonly id: string;
  readonly key: string;
  readonly actor: string;
  readonly reason: string;
  readonly scopePath?: readonly ScopeInstance[] | undefined;
  readonly layer: string;
  readonly createdAt: string; // ISO
  readonly followUpDeadline: string; // ISO (createdAt + 24h)
  readonly regularizedAt?: string | undefined;
  readonly regularizedBy?: string | undefined;
}
