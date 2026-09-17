import { AsyncLocalStorage } from "node:async_hooks";
import type { BatchOperationLease } from "./config-operation-lease";

export class ConfigBatchContext {
  private readonly storage = new AsyncLocalStorage<BatchOperationLease>();

  current(): BatchOperationLease | undefined {
    return this.storage.getStore();
  }

  run<T>(lease: BatchOperationLease, operation: () => Promise<T>): Promise<T> {
    return this.storage.run(lease, operation);
  }
}
