// Stdout audit sink — writes JSON-serialized entries one per line
import type { ConfigAuditEntry, ConfigAuditSink } from "./types";

export function createStdoutAuditSink(): ConfigAuditSink {
  return {
    async record(entry: ConfigAuditEntry): Promise<void> {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    },
  };
}
