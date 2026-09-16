import { createWeaverError } from "@weaver-conf/config-types";
import { watchConfigurationProviders } from "./config-provider-watch";
import type { ConfigServiceController } from "./config-service-controller";
import {
  notifyConfigServiceMaintenance,
  notifyConfigServiceResume,
} from "./config-service-lifecycle";

/** Owns stoppable background work and the application admission barrier. */
export class MaintenanceController {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private watches: ReturnType<typeof watchConfigurationProviders> = [];

  constructor(private readonly host: ConfigServiceController) {}

  start(): void {
    this.watches = watchConfigurationProviders(this.host);
  }

  scheduleFlush(): void {
    if (
      this.host.isClosed ||
      this.host.batchContext.current() ||
      this.host.coordinator.state() !== "open"
    )
      return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.host.coordinator
        .runApplication(() => this.flushDirty())
        .catch((error) =>
          this.host.logger.error("[config] flush failed:", error),
        );
    }, this.host.options.flushDebounceMs ?? 500);
  }

  batch<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.host.batchContext.current();
    if (current) {
      this.host.coordinator.assertBatchLease(current);
      return operation();
    }
    return this.host.coordinator.runBatch((lease) =>
      this.host.batchContext.run(lease, async () => {
        this.host.assertReady();
        try {
          return await operation();
        } finally {
          await this.host.coordinator.submitBatch(lease, () =>
            this.flushDirty(),
          );
        }
      }),
    );
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    await this.flushDirty();
  }

  enter(onRequested?: () => void): Promise<void> {
    const firstRequest = this.host.coordinator.state() === "open";
    let requestFailed = false;
    const fence = this.host.coordinator.closeApplicationAdmission(async () => {
      this.host.suspendApplication();
      await this.awaitCleanup(cleanup);
      if (requestFailed) this.failMaintenanceRequest();
      await this.flushDirty();
    });
    if (firstRequest) this.host.runtime?.closePublication();
    if (firstRequest)
      try {
        notifyConfigServiceMaintenance(this.host.getService());
        onRequested?.();
      } catch {
        requestFailed = true;
      }
    this.cancelTimer();
    const watches = this.watches;
    this.watches = [];
    const cleanup = watches.map(({ run }) => {
      try {
        return Promise.resolve(run());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    return fence;
  }

  resume(): void {
    const state = this.host.coordinator.state();
    if (state === "open") return;
    this.host.openApplication();
    try {
      notifyConfigServiceResume(this.host.getService());
    } catch {
      this.host.suspendApplication();
      this.host.runtime?.closePublication();
      this.host.coordinator.sealApplicationAdmission();
      try {
        notifyConfigServiceMaintenance(this.host.getService());
      } catch {
        // Admission is already sealed; notification still visits every listener.
      }
      this.failMaintenanceRequest();
    }
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

  private async awaitCleanup(cleanup: readonly Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(cleanup);
    if (results.some(({ status }) => status === "rejected"))
      this.failMaintenanceRequest();
  }

  private failMaintenanceRequest(): never {
    throw createWeaverError(
      "MAINTENANCE",
      "Maintenance request cleanup failed",
    );
  }

  private cancelTimer(): void {
    if (!this.debounceTimer) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }
}
