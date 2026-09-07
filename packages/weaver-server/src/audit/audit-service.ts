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
        sinks.map((sink) => sink.record(masked)),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          logger.error("[audit] sink failed:", result.reason);
        }
      }
    },
  };
}

function hasAuditedValues(
  entry: ConfigAuditEntry,
): entry is Extract<ConfigAuditEntry, { readonly domain: "config" | "sink" }> {
  // Accept legacy sink entries that predate the domain discriminator.
  return (
    !("domain" in entry) || entry.domain === "config" || entry.domain === "sink"
  );
}
