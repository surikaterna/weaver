import { parsePath } from "@weaver-conf/config-engine";
import {
  type ScopeDefinition,
  weaverErrorSchema,
  writeResultSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import type { HttpContext } from "./http-transport-context";
import {
  buildScopeQuery,
  queryString,
  request,
} from "./http-transport-context";
import { unknownWriteOutcome, withWriteDeadline } from "./http-write-deadline";
import type { WeaverTransport, WriteOptions, WriteResult } from "./transport";
import type { ConfigDelta, ConfigSnapshot, Unsubscribe } from "./types";

const legacyWriteEnvelopeSchema = z.looseObject({
  data: z.unknown(),
  meta: z.object({ revision: z.string(), timestamp: z.string() }),
  error: weaverErrorSchema.optional(),
});

function writeFailure(
  code: "WRITE_UNAVAILABLE" | "WRITE_OUTCOME_UNKNOWN",
): WriteResult {
  return {
    success: false,
    error: {
      code,
      message:
        code === "WRITE_UNAVAILABLE"
          ? "Write was not sent"
          : "Write outcome cannot be determined; check server state before retrying",
    },
  };
}

function writePath(key: string): string {
  return `/v1/config/${parsePath(key).map(encodeURIComponent).join("/")}`;
}

export function readMethods(
  context: HttpContext,
): Pick<
  WeaverTransport,
  "resolveAll" | "get" | "inspect" | "listScopes" | "listScopeValues"
> {
  return {
    async resolveAll(options): Promise<ConfigSnapshot> {
      const scope = buildScopeQuery(options?.scopePath);
      return request(
        context,
        "GET",
        `/v1/config${queryString({ scope: scope || undefined })}`,
      );
    },
    async get(key, options) {
      const scope = buildScopeQuery(options?.scopePath);
      const path = key.replace(/\./g, "/");
      const result = await request<{ key: string; value: unknown }>(
        context,
        "GET",
        `/v1/config/${path}${queryString({ scope: scope || undefined })}`,
      );
      return result.value;
    },
    async inspect(key) {
      const path = key.replace(/\./g, "/");
      return request(context, "GET", `/v1/config/${path}?inspect`);
    },
    async listScopes(): Promise<ScopeDefinition[]> {
      return (
        await request<{ definitions: ScopeDefinition[] }>(
          context,
          "GET",
          "/v1/scopes",
        )
      ).definitions;
    },
    async listScopeValues(scopeId) {
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

export function namespaceMethods(
  context: HttpContext,
): Pick<WeaverTransport, "getNamespace"> {
  return {
    async getNamespace(prefix, options) {
      const scope = buildScopeQuery(options?.scopePath);
      const path = prefix.replace(/\./g, "/");
      const result = await request<{ key: string; value: unknown }>(
        context,
        "GET",
        `/v1/config/${path}${queryString({ scope: scope || undefined })}`,
      );
      if (!isRecord(result.value)) return {};
      return result.value;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function streamMethods(
  sse: HttpContext["sse"],
): Pick<WeaverTransport, "subscribe" | "close"> {
  return {
    subscribe(handler: (delta: ConfigDelta) => void): Unsubscribe {
      sse.deltaHandlers.add(handler);
      if (sse.deltaHandlers.size === 1) sse.connect();
      return () => {
        sse.deltaHandlers.delete(handler);
        if (sse.deltaHandlers.size === 0) sse.disconnect();
      };
    },
    async close() {
      sse.disconnect();
      sse.deltaHandlers.clear();
    },
  };
}

export function writeMethods(
  context: HttpContext,
): Pick<WeaverTransport, "set" | "setMany" | "remove"> {
  return {
    async set(key, value, options) {
      let path: string;
      try {
        path = writePath(key);
      } catch {
        return writeFailure("WRITE_UNAVAILABLE");
      }
      return sendWrite(context, "PUT", path, { value }, options);
    },
    async setMany(entries, options) {
      return sendWrite(context, "PATCH", "/v1/config", { entries }, options);
    },
    async remove(key, options) {
      let path: string;
      try {
        path = writePath(key);
      } catch {
        return writeFailure("WRITE_UNAVAILABLE");
      }
      return sendWrite(context, "DELETE", path, undefined, options);
    },
  };
}

async function sendWrite(
  context: HttpContext,
  method: "DELETE" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  options?: WriteOptions,
): Promise<WriteResult> {
  const query = queryString({
    layer: options?.layer,
    env: options?.environment,
  });
  const headers = context.buildHeaders();
  if (options?.ifRevision) headers["If-Match"] = `"${options.ifRevision}"`;
  let payload: string | undefined;
  try {
    if (body !== undefined) payload = JSON.stringify(body);
    if (body !== undefined && payload === undefined)
      return writeFailure("WRITE_UNAVAILABLE");
  } catch {
    return writeFailure("WRITE_UNAVAILABLE");
  }
  try {
    return await withWriteDeadline(
      context.timeout,
      async (signal) => {
        const response = await context.fetchFn(
          `${context.baseUrl}${path}${query}`,
          {
            method,
            headers,
            signal,
            ...(payload !== undefined ? { body: payload } : {}),
          },
        );
        return decodeWriteResponse(response);
      },
      () => {
        context.onError?.({
          type: "timeout",
          message: "Request timed out",
          retryable: false,
        });
        return unknownWriteOutcome();
      },
    );
  } catch {
    return unknownWriteOutcome();
  }
}

async function decodeWriteResponse(response: Response): Promise<WriteResult> {
  const parsed = legacyWriteEnvelopeSchema.safeParse(await response.json());
  if (!parsed.success) return writeFailure("WRITE_OUTCOME_UNKNOWN");
  if (response.ok) {
    if (parsed.data.error !== undefined)
      return writeFailure("WRITE_OUTCOME_UNKNOWN");
    const result = writeResultSchema.safeParse(parsed.data.data);
    return result.success &&
      result.data.success &&
      result.data.error === undefined
      ? result.data
      : writeFailure("WRITE_OUTCOME_UNKNOWN");
  }
  const error = weaverErrorSchema.safeParse(parsed.data.error);
  if (!error.success || parsed.data.data !== null)
    return writeFailure("WRITE_OUTCOME_UNKNOWN");
  return { success: false, error: error.data };
}
