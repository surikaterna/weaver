import type { TransportError } from "./http-transport-types";
import type { WriteResult } from "./transport";

export function onceWriteError(onError?: (error: TransportError) => void) {
  let reported = false;
  return (error: TransportError): void => {
    if (reported) return;
    reported = true;
    try {
      onError?.(error);
    } catch {
      // Diagnostic hooks cannot change the write outcome.
    }
  };
}

export function unknownWriteOutcome(): WriteResult {
  return {
    success: false,
    error: {
      code: "WRITE_OUTCOME_UNKNOWN",
      message:
        "Write outcome cannot be determined; check server state before retrying",
    },
  };
}

/** A write deadline bounds dispatch and response decoding even when fetch ignores abort. */
export async function withWriteDeadline<T>(
  timeout: number,
  dispatch: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, timeout);
  });
  try {
    // Promise.race observes late rejections; neither late outcome can change the result.
    return await Promise.race([dispatch(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
