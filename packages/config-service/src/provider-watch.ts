import { createWeaverError } from "@weaver-conf/config-types";
import { reloadProvider } from "./provider-reload";
import { closeResources, type Resource } from "./resource-ownership";
import type { RootState } from "./root-state";

/** Hints convey no data or authority. Each binding retains at most one follow-up. */
export function startProviderWatches(state: RootState): () => void {
  const resources: Resource[] = [];
  const starters: (() => void)[] = [];
  let active = false;
  let stopped = false;
  state.stopWatching = captureStop(resources, () => {
    stopped = true;
  });
  for (const binding of state.factory.captured) {
    if (!binding.watch) continue;
    let dirty = false;
    let running = false;
    let reading = false;
    const schedule = () => {
      if (!active || stopped || state.disposed || running || !dirty) return;
      if (state.writeFence || state.schemaFence) {
        dirty = false;
        return;
      }
      dirty = false;
      running = true;
      void reloadProvider(state, binding.binding.id, "external", () => {
        reading = true;
      })
        .finally(() => {
          running = false;
          reading = false;
          schedule();
        })
        .catch(() => {});
    };
    const hint = () => {
      if (stopped || state.disposed || state.writeFence || state.schemaFence)
        return;
      if (running && !reading) return;
      dirty = true;
      schedule();
    };
    resources.push({
      id: binding.binding.id,
      close: subscribe(binding.watch, hint),
    });
    starters.push(schedule);
  }
  return () => {
    active = true;
    for (const start of starters) start();
  };
}

function captureStop(resources: readonly Resource[], stop: () => void) {
  let closing: Promise<readonly string[]> | undefined;
  return () => {
    stop();
    closing ??= closeResources(resources);
    return closing;
  };
}

function subscribe(
  watch: (hint: () => void) => unknown,
  hint: () => void,
): () => Promise<void> {
  try {
    const release = watch(hint);
    if (typeof release === "function")
      return async () => {
        await release();
      };
    // Invalid asynchronous returns remain rejected, but cannot leak rejections.
    void Promise.resolve(release).catch(() => {});
  } catch {
    /* Invalid host capability errors must not expose provider payloads. */
  }
  throw createWeaverError(
    "VALIDATION_ERROR",
    "Provider watch did not return an unsubscribe function",
  );
}
