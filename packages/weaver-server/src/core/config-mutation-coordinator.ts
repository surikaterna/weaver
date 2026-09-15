import { AsyncLocalStorage } from "node:async_hooks";
import { createWeaverError } from "@weaver-conf/config-types";

/** Reentry rejects before enqueueing; independent callers still share one queue. */
export function createConfigMutationCoordinator() {
  let pending: Promise<unknown> = Promise.resolve();
  const ownership = new AsyncLocalStorage<{ active: boolean }>();
  const assertNotRunning = () => {
    if (ownership.getStore()?.active)
      throw createWeaverError(
        "FORBIDDEN",
        "Reentrant configuration operation is not permitted",
      );
  };
  return {
    assertNotRunning,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertNotRunning();
      const result = pending.then(() => {
        const owner = { active: true };
        return ownership.run(owner, async () => {
          try {
            return await operation();
          } finally {
            owner.active = false;
          }
        });
      });
      pending = result.catch(() => undefined);
      return result;
    },
  };
}
