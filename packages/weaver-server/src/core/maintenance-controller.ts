import { runIndependentCleanup } from "@weaver-conf/config-engine";
import { watchConfigurationProviders } from "./config-provider-watch";
import type { ConfigServiceController } from "./config-service-controller";

/** Owns stoppable background work and the application admission barrier. */
export class MaintenanceController {
  private batchDepth = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private watches: ReturnType<typeof watchConfigurationProviders> = [];

  constructor(private readonly host: ConfigServiceController) {}

  start(): void {
    this.watches = watchConfigurationProviders(this.host);
  }

  scheduleFlush(): void {
    if (this.host.isClosed || this.batchDepth > 0) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.host.coordinator
        .run(() => this.flushDirty())
        .catch((error) =>
          this.host.logger.error("[config] flush failed:", error),
        );
    }, this.host.options.flushDebounceMs ?? 500);
  }

  async batch<T>(operation: () => Promise<T>): Promise<T> {
    this.host.coordinator.assertNotRunning();
    this.host.assertReady();
    this.batchDepth++;
    try {
      return await operation();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0)
        await this.host.coordinator.run(() => this.flushDirty());
    }
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    await this.flushDirty();
  }

  async enter(): Promise<void> {
    this.host.suspendApplication();
    this.cancelTimer();
    const watches = this.watches;
    this.watches = [];
    await runIndependentCleanup([
      ...watches,
      { name: "managed provider buffers", run: () => this.flushDirty() },
    ]);
  }

  resume(): void {
    this.host.openApplication();
    this.start();
  }

  stopSteps() {
    this.cancelTimer();
    const watches = this.watches;
    this.watches = [];
    return watches;
  }

  private async flushDirty(): Promise<void> {
    for (const provider of this.host.providers)
      if (provider.flush && provider.dirty) await provider.flush();
  }

  private cancelTimer(): void {
    if (!this.debounceTimer) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }
}
