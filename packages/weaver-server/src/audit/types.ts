// Unified audit interfaces for Weaver configuration changes

import type {
  ConfigAuditEntry,
  ConfigDomainAuditEntry,
  SinkDomainAuditEntry,
} from "@weaver-conf/config-types";

/**
 * Queryable audit log — supports append and various query patterns.
 * Used by config-server for full audit history access.
 */
export interface ConfigAuditLog {
  append(entry: ConfigDomainAuditEntry): Promise<void>;
  queryByKey(key: string): Promise<ConfigDomainAuditEntry[]>;
  queryByTimeRange(from: string, to: string): Promise<ConfigDomainAuditEntry[]>;
  getRecent(limit?: number | undefined): Promise<ConfigDomainAuditEntry[]>;
}

/**
 * Write-only audit sink — receives masked entries from the audit service dispatcher.
 * Uses SinkDomainAuditEntry which includes environment context.
 */
export interface ConfigAuditSink {
  record(entry: ConfigAuditEntry): Promise<void>;
}

// Re-export for backward compatibility
export type { ConfigAuditEntry, ConfigDomainAuditEntry, SinkDomainAuditEntry };
