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
import type { WeaverTransport, WriteOptions, WriteResult } from "./transport";
import type { ConfigDelta, ConfigSnapshot, Unsubscribe } from "./types";

const legacyWriteEnvelopeSchema = z.looseObject({
  data: z.unknown(),
  error: weaverErrorSchema.optional(),
});

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
      return sendWrite(
        context,
        "PUT",
        `/v1/config/${key.replace(/\./g, "/")}`,
        { value },
        options,
      );
    },
    async setMany(entries, options) {
      return sendWrite(context, "PATCH", "/v1/config", { entries }, options);
    },
    async remove(key, options) {
      return sendWrite(
        context,
        "DELETE",
        `/v1/config/${key.replace(/\./g, "/")}`,
        undefined,
        options,
      );
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
  const response = await context.fetchFn(`${context.baseUrl}${path}${query}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const envelope = legacyWriteEnvelopeSchema.parse(await response.json());
  if (response.ok) return writeResultSchema.parse(envelope.data);
  const error = weaverErrorSchema.parse(envelope.error);
  return { success: false, error };
}
