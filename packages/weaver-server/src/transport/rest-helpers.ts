// REST adapter helper utilities — extracted to keep rest-adapter.ts under 400 lines

import { configServiceTransportRevision } from "../core/config-service-lifecycle";
import type { WeaverConfigService } from "../core/config-service-types";
import type { WeaverError } from "../types/index";
import {
  createWeaverError,
  httpStatusForError,
  type WeaverErrorCode,
} from "../types/index";
import type { RestRequest, RestResponse } from "./rest-adapter";

export interface ApiResponse<T> {
  data: T;
  meta: { revision: string; timestamp: string };
}

export interface ApiErrorResponse {
  data: null;
  meta: { revision: string; timestamp: string };
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function matchPath(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  const params: Record<string, string> = {};

  for (const [i, pp] of patternParts.entries()) {
    if (pp.startsWith("*")) {
      const remaining = pathParts.slice(i);
      if (remaining.length === 0) return null;
      params[pp.slice(1)] = remaining.join("/");
      return params;
    }
    if (i >= pathParts.length) return null;
    if (pp.startsWith(":")) {
      const pathPart = pathParts[i];
      if (pathPart === undefined) return null;
      params[pp.slice(1)] = pathPart;
    } else if (pp !== pathParts[i]) {
      return null;
    }
  }

  if (patternParts.length !== pathParts.length) return null;
  return params;
}

const defaultCorsMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const defaultCorsHeaders = "Content-Type, Authorization";

export function corsHeaders(
  origins: string[],
  requestOrigin?: string,
  requestHeaders?: string,
): Record<string, string> {
  const normalizedOrigin = requestOrigin?.trim();
  const allowAnyOrigin = origins.includes("*");

  if (allowAnyOrigin) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": defaultCorsMethods,
      "Access-Control-Allow-Headers": requestHeaders ?? defaultCorsHeaders,
    };
  }

  if (!normalizedOrigin || !origins.includes(normalizedOrigin)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": normalizedOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": defaultCorsMethods,
    "Access-Control-Allow-Headers": requestHeaders ?? defaultCorsHeaders,
  };
}

export function envelope<T>(data: T, revision: string): ApiResponse<T> {
  return { data, meta: { revision, timestamp: new Date().toISOString() } };
}

export function errorEnvelope(
  error: WeaverError,
  revision: string,
): ApiErrorResponse {
  const details = error.details ? { details: error.details } : {};
  return {
    data: null,
    meta: { revision, timestamp: new Date().toISOString() },
    error: { code: error.code, message: error.message, ...details },
  };
}

export function v1Headers(
  revision: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ETag: `"${revision}"`,
    "Cache-Control": "no-cache",
    ...extra,
  };
}

export function param(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (!value)
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Missing required route parameter: ${name}`,
    );
  return value;
}

export function queryOpt(
  query: Record<string, string>,
  name: string,
): string | undefined {
  return query[name];
}

export function v1Response<T>(
  service: WeaverConfigService,
  status: number,
  data: T,
): RestResponse {
  const revision = configServiceTransportRevision(service);
  return {
    status,
    body: envelope(data, revision),
    headers: v1Headers(revision),
  };
}

export function v1Error(
  service: WeaverConfigService,
  code: WeaverErrorCode,
  message: string,
): RestResponse {
  const revision = configServiceTransportRevision(service);
  return {
    status: httpStatusForError(code),
    body: errorEnvelope(createWeaverError(code, message), revision),
    headers: v1Headers(revision),
  };
}

export function extractExpectedRevision(req: RestRequest): string | undefined {
  return req.headers["if-match"]?.replace(/^"|"$/g, "");
}
