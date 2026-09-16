import type { WeaverLogger } from "@weaver-conf/config-engine";
import type { ConfigDelta } from "../types/index";

export class RuntimePublicationGate {
  private readonly handlers = new Set<(delta: ConfigDelta) => void>();
  private open = true;

  constructor(private readonly logger: WeaverLogger) {}

  subscribe(handler: (delta: ConfigDelta) => void): () => void {
    if (!this.open) return () => undefined;
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.open = false;
    this.handlers.clear();
  }

  reopen(): void {
    this.open = true;
  }

  acceptsPublication(): boolean {
    return this.open;
  }

  dispatch(deltas: ReadonlyArray<ConfigDelta>): void {
    if (!this.open) return;
    for (const delta of deltas) this.dispatchDelta(delta);
  }

  private dispatchDelta(delta: ConfigDelta): void {
    for (const handler of [...this.handlers]) {
      try {
        // Only synchronous callback entry is fenced; detached user work is not owned.
        handler(delta);
      } catch (error: unknown) {
        this.logError("[config] delta listener failed:", error);
      }
    }
  }

  logError(message: string, error: unknown): void {
    try {
      this.logger.error(message, error);
    } catch {
      // Diagnostics cannot change committed configuration semantics.
    }
  }
}
