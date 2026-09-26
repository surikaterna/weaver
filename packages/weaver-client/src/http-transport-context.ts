import type { ScopeInstance } from "@weaver-conf/config-types";
import { formatScopePath } from "@weaver-conf/config-types";
import { createHttpRequester } from "./http-request";
import type { HttpTransportOptions } from "./http-transport-types";
import { createSSEConnection } from "./sse-connection";

export function createHttpContext(options: HttpTransportOptions) {
  const { baseUrl, token, headers: extraHeaders } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const onError = options.onError;
  const retry = {
    maxAttempts: options.retry?.maxAttempts ?? 3,
    baseDelay: options.retry?.baseDelay ?? 1000,
    maxDelay: options.retry?.maxDelay ?? 10000,
  };
  const buildHeaders = () => requestHeaders(token, extraHeaders);
  const sse = createSSEConnection({
    baseUrl,
    token,
    extraHeaders,
    fetchFn,
    maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
    onError,
  });
  const requester = createHttpRequester({
    baseUrl,
    buildHeaders,
    fetchFn,
    onError,
    retry,
    timeout: options.timeout ?? 30000,
  });
  return { baseUrl, buildHeaders, fetchFn, requester, sse };
}

export type HttpContext = ReturnType<typeof createHttpContext>;

function requestHeaders(
  token?: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function buildScopeQuery(scopePath?: ScopeInstance[]): string {
  if (!scopePath?.length) return "";
  return formatScopePath(scopePath);
}

export function queryString(
  params: Record<string, string | undefined>,
): string {
  const entries = Object.entries(params).filter(
    (pair): pair is [string, string] => pair[1] !== undefined,
  );
  if (entries.length === 0) return "";
  return `?${entries
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&")}`;
}

export async function request<T>(
  context: HttpContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // SAFETY: legacy endpoints do not yet export response schemas.
  return (await context.requester.request(method, path, body)) as T;
}
