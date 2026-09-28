import type { TransportError } from "./http-transport-types";

/** Configuration for retry behavior on failed HTTP requests. */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
}

/** Internal options passed to fetchWithRetry including resolved defaults. */
export interface RequestWithRetryOptions {
  retry: Required<RetryOptions>;
  timeout: number;
  fetchFn: typeof globalThis.fetch;
  onError?: ((error: TransportError) => void) | undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status >= 500;
}

function computeDelay(attempt: number, base: number, max: number): number {
  return Math.min(base * 2 ** attempt, max);
}

type CancellationType = "abort" | "timeout";
type AttemptFailureType = CancellationType | "connection";

interface AttemptCancellation {
  readonly controller: AbortController;
  readonly cleanup: () => void;
  readonly type: () => CancellationType | undefined;
}

type AttemptResult =
  | { readonly ok: true; readonly response: Response }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly type: AttemptFailureType;
    };

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function createAttemptCancellation(
  callerSignal: AbortSignal | undefined,
  timeout: number,
): AttemptCancellation {
  const controller = new AbortController();
  let cancellationType: CancellationType | undefined;
  const cancel = (type: CancellationType, reason?: unknown) => {
    if (cancellationType) return;
    cancellationType = type;
    controller.abort(reason);
  };
  const onCallerAbort = () => {
    if (callerSignal) cancel("abort", abortError(callerSignal));
  };
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => cancel("timeout"), timeout);
  return {
    controller,
    type: () => cancellationType,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function reportAttemptFailure(
  type: AttemptFailureType,
  error: unknown,
  retryable: boolean,
  onError: RequestWithRetryOptions["onError"],
): void {
  const message = error instanceof Error ? error.message : String(error);
  onError?.({ type, message, retryable });
}

async function waitForRetry(
  delay: number,
  callerSignal: AbortSignal | undefined,
  onError: RequestWithRetryOptions["onError"],
): Promise<void> {
  if (!callerSignal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return;
  }
  const signal = callerSignal;
  if (signal.aborted) return rejectCallerAbort(signal, onError);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delay);
    const onAbort = () => finish(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    function finish(error?: Error): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  }).catch((error: unknown) => {
    reportAttemptFailure("abort", error, false, onError);
    throw error;
  });
}

function rejectCallerAbort(
  signal: AbortSignal,
  onError: RequestWithRetryOptions["onError"],
): never {
  const error = abortError(signal);
  reportAttemptFailure("abort", error, false, onError);
  throw error;
}

async function executeAttempt(
  url: string,
  init: RequestInit,
  options: RequestWithRetryOptions,
  retryable: boolean,
): Promise<AttemptResult> {
  const cancellation = createAttemptCancellation(
    init.signal ?? undefined,
    options.timeout,
  );
  try {
    const response = await options.fetchFn(url, {
      ...init,
      signal: cancellation.controller.signal,
    });
    if (cancellation.type()) throw cancellation.controller.signal.reason;
    return { ok: true, response };
  } catch (error) {
    const type = cancellation.type() ?? "connection";
    reportAttemptFailure(
      type,
      error,
      type !== "abort" && retryable,
      options.onError,
    );
    return { ok: false, error, type };
  } finally {
    cancellation.cleanup();
  }
}

/**
 * Executes a fetch request with timeout and retry logic.
 * Retries network errors, timeouts, 429, and 5xx responses.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RequestWithRetryOptions,
): Promise<Response> {
  const { retry, onError } = options;
  const callerSignal = init.signal ?? undefined;

  if (callerSignal?.aborted) rejectCallerAbort(callerSignal, onError);

  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    const retryable = attempt < retry.maxAttempts - 1;
    const result = await executeAttempt(url, init, options, retryable);
    if (!result.ok) {
      if (!retryable || result.type === "abort") throw result.error;
    } else if (!isRetryableStatus(result.response.status) || !retryable) {
      return result.response;
    } else {
      onError?.({
        type: "server",
        message: `HTTP ${result.response.status}`,
        statusCode: result.response.status,
        retryable: true,
      });
    }
    await waitForRetry(
      computeDelay(attempt, retry.baseDelay, retry.maxDelay),
      callerSignal,
      onError,
    );
  }

  // Unreachable but satisfies TypeScript
  throw new Error("Retry exhausted");
}
