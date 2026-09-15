import type { ScopeDefinition, ScopeInstance } from "@weaver-conf/config-types";
import { formatScopePath } from "@weaver-conf/config-types";
import {
  fetchRegisteredSchemas,
  patchRegisteredPath as patchRegisteredPathRequest,
  postSchemaRegistration,
  putRegisteredObject,
  validateRegisteredEffective as validateRegisteredEffectiveRequest,
} from "./http-registered-transport";
import { createHttpRequester } from "./http-request";
import type { RetryOptions } from "./http-retry";
import { createSSEConnection } from "./sse-connection";
import type { WeaverTransport, WriteOptions, WriteResult } from "./transport";
import type {
  ConfigDelta,
  ConfigSnapshot,
  GetOptions,
  ResolveOptions,
  Unsubscribe,
} from "./types";

export interface TransportError {
  type: "abort" | "connection" | "timeout" | "parse" | "server";
  message: string;
  statusCode?: number;
  retryable: boolean;
}

export interface HttpTransportOptions {
  /** Base URL of the weaver-server (e.g. "http://localhost:3399") */
  baseUrl: string;
  /** Auth token (JWT) — injected into Authorization header */
  token?: string;
  /** Additional headers for all requests */
  headers?: Record<string, string>;
  /** Custom fetch implementation (defaults to global fetch) */
  fetch?: typeof globalThis.fetch;
  /** Maximum reconnection attempts for SSE (default: Infinity) */
  maxReconnectAttempts?: number;
  /** Error callback for transport-level errors */
  onError?: (error: TransportError) => void;
  /** Retry configuration for failed requests */
  retry?: RetryOptions;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Creates an HTTP/SSE transport that connects to a weaver-server instance.
 * Supports authentication, retry logic, and real-time delta streaming via Server-Sent Events.
 */
export function createHttpTransport(
  options: HttpTransportOptions,
): WeaverTransport & { lastCheckpoint: number } {
  const context = createHttpContext(options);
  const registeredContext = {
    buildScopeQuery,
    queryString,
    requestValidated: context.requester.requestValidated,
  };
  return {
    ...readMethods(context),
    ...namespaceMethods(context),
    ...writeMethods(context),
    ...registeredMethods(registeredContext),
    ...streamMethods(context.sse),
    get lastCheckpoint() {
      return context.sse.lastCheckpoint;
    },
  };
}

function createHttpContext(options: HttpTransportOptions) {
  const { baseUrl, token, headers: extraHeaders } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const onError = options.onError;
  const retryConfig = {
    maxAttempts: options.retry?.maxAttempts ?? 3,
    baseDelay: options.retry?.baseDelay ?? 1000,
    maxDelay: options.retry?.maxDelay ?? 10000,
  };
  const requestTimeout = options.timeout ?? 30000;

  const sse = createSSEConnection({
    baseUrl,
    token,
    extraHeaders,
    fetchFn,
    maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
    onError,
  });

  const buildHeaders = () => requestHeaders(token, extraHeaders);
  const requester = createHttpRequester({
    baseUrl,
    buildHeaders,
    fetchFn,
    onError,
    retry: retryConfig,
    timeout: requestTimeout,
  });
  return { sse, requester, fetchFn, baseUrl, buildHeaders };
}

type HttpContext = ReturnType<typeof createHttpContext>;

function requestHeaders(
  token?: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

function buildScopeQuery(scopePath?: ScopeInstance[]): string {
  if (!scopePath?.length) return "";
  return formatScopePath(scopePath);
}

function queryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (pair): pair is [string, string] => pair[1] !== undefined,
  );
  if (entries.length === 0) return "";
  return (
    "?" +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&")
  );
}

async function request<T>(
  context: HttpContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // SAFETY: legacy endpoints do not yet export response schemas.
  return (await context.requester.request(method, path, body)) as T;
}

function readMethods(
  context: HttpContext,
): Pick<
  WeaverTransport,
  "resolveAll" | "get" | "inspect" | "listScopes" | "listScopeValues"
> {
  return {
    async resolveAll(opts?: ResolveOptions): Promise<ConfigSnapshot> {
      const scope = buildScopeQuery(opts?.scopePath);
      const qs = queryString({ scope: scope || undefined });
      return request<ConfigSnapshot>(context, "GET", `/v1/config${qs}`);
    },

    async get(key: string, opts?: GetOptions): Promise<unknown> {
      const scope = buildScopeQuery(opts?.scopePath);
      const keyPath = key.replace(/\./g, "/");
      const qs = queryString({ scope: scope || undefined });
      const result = await request<{ key: string; value: unknown }>(
        context,
        "GET",
        `/v1/config/${keyPath}${qs}`,
      );
      return result.value;
    },

    async inspect(key: string): Promise<unknown> {
      const keyPath = key.replace(/\./g, "/");
      return request<unknown>(context, "GET", `/v1/config/${keyPath}?inspect`);
    },
    async listScopes() {
      return (
        await request<{ definitions: ScopeDefinition[] }>(
          context,
          "GET",
          "/v1/scopes",
        )
      ).definitions;
    },
    async listScopeValues(scopeId: string) {
      return (
        await request<{ values: string[] }>(
          context,
          "GET",
          `/v1/scopes/${encodeURIComponent(scopeId)}`,
        )
      ).values;
    },
  };
}

function namespaceMethods(
  context: HttpContext,
): Pick<WeaverTransport, "getNamespace"> {
  return {
    async getNamespace(
      prefix: string,
      opts?: GetOptions,
    ): Promise<Record<string, unknown>> {
      const scope = buildScopeQuery(opts?.scopePath);
      const keyPath = prefix.replace(/\./g, "/");
      const qs = queryString({ scope: scope || undefined });
      const result = await request<{ key: string; value: unknown }>(
        context,
        "GET",
        `/v1/config/${keyPath}${qs}`,
      );
      if (
        result.value &&
        typeof result.value === "object" &&
        !Array.isArray(result.value)
      ) {
        return result.value as Record<string, unknown>; // SAFETY: guarded by typeof/null/array checks
      }
      return {};
    },
  };
}

function streamMethods(
  sse: HttpContext["sse"],
): Pick<WeaverTransport, "subscribe" | "close"> {
  return {
    subscribe(handler: (delta: ConfigDelta) => void): Unsubscribe {
      sse.deltaHandlers.add(handler);
      if (sse.deltaHandlers.size === 1) {
        sse.connect();
      }
      return () => {
        sse.deltaHandlers.delete(handler);
        if (sse.deltaHandlers.size === 0) {
          sse.disconnect();
        }
      };
    },

    async close(): Promise<void> {
      sse.disconnect();
      sse.deltaHandlers.clear();
    },
  };
}

function setMethods({
  fetchFn,
  baseUrl,
  buildHeaders,
}: HttpContext): Pick<WeaverTransport, "set"> {
  return {
    async set(
      key: string,
      value: unknown,
      opts?: WriteOptions,
    ): Promise<WriteResult> {
      const keyPath = key.replace(/\./g, "/");
      const qs = queryString({ layer: opts?.layer, env: opts?.environment });
      const headers = buildHeaders();
      if (opts?.ifRevision) {
        headers["If-Match"] = `"${opts.ifRevision}"`;
      }
      const res = await fetchFn(`${baseUrl}/v1/config/${keyPath}${qs}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ value }),
      });
      // SAFETY: server API contract guarantees this response shape
      const json = (await res.json()) as {
        data: WriteResult;
        error?: {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
      };
      if (!res.ok && json.error) {
        return { success: false, error: json.error };
      }
      return json.data;
    },
  };
}

function batchMethods({
  fetchFn,
  baseUrl,
  buildHeaders,
}: HttpContext): Pick<WeaverTransport, "setMany"> {
  return {
    async setMany(
      entries: Record<string, unknown>,
      opts?: WriteOptions,
    ): Promise<WriteResult> {
      const qs = queryString({ layer: opts?.layer, env: opts?.environment });
      const headers = buildHeaders();
      if (opts?.ifRevision) {
        headers["If-Match"] = `"${opts.ifRevision}"`;
      }
      const res = await fetchFn(`${baseUrl}/v1/config${qs}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ entries }),
      });
      // SAFETY: server API contract guarantees this response shape
      const json = (await res.json()) as {
        data: WriteResult;
        error?: {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
      };
      if (!res.ok && json.error) {
        return { success: false, error: json.error };
      }
      return json.data;
    },
  };
}

function removeMethods({
  fetchFn,
  baseUrl,
  buildHeaders,
}: HttpContext): Pick<WeaverTransport, "remove"> {
  return {
    async remove(key: string, opts?: WriteOptions): Promise<WriteResult> {
      const keyPath = key.replace(/\./g, "/");
      const qs = queryString({ layer: opts?.layer, env: opts?.environment });
      const headers = buildHeaders();
      if (opts?.ifRevision) {
        headers["If-Match"] = `"${opts.ifRevision}"`;
      }
      const res = await fetchFn(`${baseUrl}/v1/config/${keyPath}${qs}`, {
        method: "DELETE",
        headers,
      });
      // SAFETY: server API contract guarantees this response shape
      const json = (await res.json()) as {
        data: WriteResult;
        error?: {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
      };
      if (!res.ok && json.error) {
        return { success: false, error: json.error };
      }
      return json.data;
    },
  };
}

function writeMethods(context: HttpContext) {
  return {
    ...setMethods(context),
    ...batchMethods(context),
    ...removeMethods(context),
  };
}

function registeredMethods(
  registeredContext: Parameters<typeof fetchRegisteredSchemas>[0],
): Pick<
  WeaverTransport,
  | "fetchSchemas"
  | "registerSchema"
  | "setRegisteredObject"
  | "patchRegisteredPath"
  | "validateRegisteredEffective"
> {
  return {
    async fetchSchemas() {
      return fetchRegisteredSchemas(registeredContext);
    },

    async registerSchema(requestBody, options) {
      return postSchemaRegistration(registeredContext, requestBody, options);
    },

    async setRegisteredObject(anchorPath, value, opts?) {
      return putRegisteredObject(registeredContext, anchorPath, value, opts);
    },

    async patchRegisteredPath(path, value, opts?) {
      return patchRegisteredPathRequest(registeredContext, path, value, opts);
    },

    async validateRegisteredEffective(options) {
      return validateRegisteredEffectiveRequest(registeredContext, options);
    },
  };
}
