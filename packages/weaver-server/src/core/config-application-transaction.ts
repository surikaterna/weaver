import type { WriteResult } from "@weaver-conf/config-types";
import type { ConfigServiceController } from "./config-service-controller";
import type { WriteContext } from "./config-service-types";

export interface ApplicationControlTransaction {
  readonly revision: string;
  readonly read: () => unknown;
  readonly write: (
    key: string,
    value: unknown,
    options?: WriteContext,
  ) => Promise<WriteResult>;
}

export interface ManagedApplicationControlTransaction {
  readonly transaction: ApplicationControlTransaction;
  readonly close: () => Promise<void>;
}

export function runApplicationControlTransaction<T>(
  host: ConfigServiceController,
  create: () => ManagedApplicationControlTransaction,
  operation: (transaction: ApplicationControlTransaction) => Promise<T>,
): Promise<T> {
  return host.coordinator.runApplication((lease) =>
    host.coordinator.continueApplication(lease, async () => {
      const managed = create();
      try {
        return await operation(managed.transaction);
      } finally {
        await managed.close();
      }
    }),
  );
}
