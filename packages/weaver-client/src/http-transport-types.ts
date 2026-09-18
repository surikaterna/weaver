import type { RetryOptions } from "./http-retry";

export interface TransportError {
  readonly type: "abort" | "connection" | "timeout" | "parse" | "server";
  readonly message: string;
  readonly statusCode?: number | undefined;
  readonly retryable: boolean;
}

export interface HttpTransportOptions {
  /** Base URL of the weaver-server (e.g. "http://localhost:3399") */
  readonly baseUrl: string;
  /** Auth token (JWT) — injected into Authorization header */
  readonly token?: string | undefined;
  /** Additional headers for all requests */
  readonly headers?: Record<string, string> | undefined;
  /** Custom fetch implementation (defaults to global fetch) */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Maximum reconnection attempts for SSE (default: Infinity) */
  readonly maxReconnectAttempts?: number | undefined;
  /** Error callback for transport-level errors */
  readonly onError?: ((error: TransportError) => void) | undefined;
  /** Retry configuration for failed requests */
  readonly retry?: RetryOptions | undefined;
  /** Request timeout in milliseconds (default: 30000) */
  readonly timeout?: number | undefined;
}
