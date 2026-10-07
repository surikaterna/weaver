import {
  createWeaverError,
  type Result,
  type WeaverError,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import { finishEffect } from "./authority/registry-effects";
import { errorData } from "./resource-ownership";
import { assertNotDisposed, type RootState } from "./root-state";

function admitFlush(state: RootState): void {
  assertNotDisposed(state);
  if (state.schemaFence)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Registry recovery requires a new root",
    );
  if (state.writeFence)
    throw createWeaverError("WRITE_UNAVAILABLE", "Mutations are fenced");
  if (state.writeHookActive)
    throw createWeaverError(
      "WRITE_UNAVAILABLE",
      "Host hook reentry is unavailable",
    );
}

/** The barrier owns only explicitly declared completion hooks, not provider data. */
export async function flushHost(
  state: RootState,
): Promise<Result<undefined, WeaverError>> {
  try {
    admitFlush(state);
    return await state.queue.enqueue(() => flushDeclared(state));
  } catch (error) {
    return {
      ok: false,
      error: errorData(
        error instanceof WeaverErrorInstance ? error.code : "SERVER_DEGRADED",
        "Host flush is unavailable",
      ),
    };
  }
}

async function flushDeclared(
  state: RootState,
): Promise<Result<undefined, WeaverError>> {
  admitFlush(state);
  const failed: string[] = [];
  for (const binding of state.factory.captured) {
    const writer = state.factory.writers.get(binding);
    if (!writer?.flush) continue;
    assertNotDisposed(state);
    state.writeHookActive = true;
    try {
      if ((await finishEffect(writer)) === "unknown") {
        failed.push(binding.binding.id);
        state.writeFence = Object.freeze([
          ...new Set([...(state.writeFence ?? []), binding.binding.id]),
        ]);
      }
    } finally {
      state.writeHookActive = false;
    }
  }
  if (failed.length)
    return {
      ok: false,
      error: errorData("WRITE_OUTCOME_UNKNOWN", "Host flush outcome unknown"),
    };
  assertNotDisposed(state);
  return { ok: true, value: undefined };
}

export async function acknowledgeRestart(
  state: RootState,
  revision: string,
): Promise<Result<undefined, WeaverError>> {
  try {
    admitFlush(state);
    return await state.queue.enqueue(() => {
      admitFlush(state);
      if (revision !== `${state.incarnation}${String(state.generation)}`)
        throw createWeaverError(
          "REVISION_CONFLICT",
          "Restart revision changed",
        );
      state.restartPending = "hot";
      return { ok: true, value: undefined } as const;
    });
  } catch (error) {
    return {
      ok: false,
      error: errorData(
        error instanceof WeaverErrorInstance ? error.code : "SERVER_DEGRADED",
        "Restart acknowledgement unavailable",
      ),
    };
  }
}
