// Audit service with pluggable sinks and sensitive value masking
import type { WeaverLogger } from "@weaver-conf/config-engine";
import { consoleLogger } from "@weaver-conf/config-engine";
import type { ConfigAuditEntry, ConfigAuditSink } from "./types";

export interface AuditServiceOptions {
  sinks: ConfigAuditSink[];
  sensitiveKeys?: Set<string>;
  logger?: WeaverLogger;
}

export interface AuditService {
  /** Schema operations treat recording as best-effort; custom implementations may reject. */
  record(entry: ConfigAuditEntry): Promise<void>;
}

export function createAuditService(options: AuditServiceOptions): AuditService {
  const { sinks, sensitiveKeys } = options;
  const logger = options.logger ?? consoleLogger;

  function maskEntry(entry: ConfigAuditEntry): ConfigAuditEntry {
    if (!hasAuditedValues(entry) || !sensitiveKeys?.has(entry.key)) {
      return entry;
    }
    return {
      ...entry,
      oldValue: entry.oldValue !== undefined ? "***" : undefined,
      newValue: entry.newValue !== undefined ? "***" : undefined,
    };
  }

  return {
    async record(entry: ConfigAuditEntry): Promise<void> {
      const masked = maskEntry(entry);
      const results = await Promise.allSettled(
        sinks.map(async (sink) => sink.record(masked)),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          try {
            logger.error("[audit] sink failed");
          } catch {
            // Diagnostics must not change the outcome of an already completed operation.
          }
        }
      }
    },
  };
}

function hasAuditedValues(
  entry: ConfigAuditEntry,
): entry is Extract<ConfigAuditEntry, { readonly domain: "config" | "sink" }> {
  return entry.domain === "config" || entry.domain === "sink";
}
