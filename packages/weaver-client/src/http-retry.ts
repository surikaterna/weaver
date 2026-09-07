import type { TransportError } from "./http-transport";

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

const NON_RETRYABLE_CODES = new Set([400, 401, 403, 404, 422]);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status >= 500;
}

function computeDelay(attempt: number, base: number, max: number): number {
  return Math.min(base * 2 ** attempt, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a fetch request with timeout and retry logic.
 * Retries on network errors, 429, and 5xx (except non-retryable codes).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RequestWithRetryOptions,
): Promise<Response> {
  const { retry, timeout, fetchFn, onError } = options;

  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetchFn(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok || NON_RETRYABLE_CODES.has(res.status)) {
        return res;
      }

      if (isRetryableStatus(res.status) && attempt < retry.maxAttempts - 1) {
        onError?.({
          type: "server",
          message: `HTTP ${res.status}`,
          statusCode: res.status,
          retryable: true,
        });
        await sleep(computeDelay(attempt, retry.baseDelay, retry.maxDelay));
        continue;
      }

      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = controller.signal.aborted;

      onError?.({
        type: isTimeout ? "timeout" : "connection",
        message,
        retryable: attempt < retry.maxAttempts - 1,
      });

      if (attempt < retry.maxAttempts - 1) {
        await sleep(computeDelay(attempt, retry.baseDelay, retry.maxDelay));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable but satisfies TypeScript
  throw new Error("Retry exhausted");
}
