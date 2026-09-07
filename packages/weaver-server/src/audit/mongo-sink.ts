// MongoDB audit sink — inserts audit entries into a collection
import { extractErrorMessage } from "@weaver-conf/config-engine";
import type { ConfigAuditEntry, ConfigAuditSink } from "./types";

export interface MongoCollection {
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
}

export interface MongoAuditSinkOptions {
  collection: MongoCollection;
}

export function createMongoAuditSink(
  options: MongoAuditSinkOptions,
): ConfigAuditSink {
  const { collection } = options;

  return {
    async record(entry: ConfigAuditEntry): Promise<void> {
      try {
        await collection.insertOne(entry as unknown as Record<string, unknown>); // SAFETY: AuditEntry is a plain object compatible with MongoDB document
      } catch (err: unknown) {
        const message = extractErrorMessage(err);
        console.error(
          `[weaver] Audit record failed (non-blocking): ${message}`,
        );
      }
    },
  };
}
