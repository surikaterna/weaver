import type { Request, Response } from "express";
import type { AuthContext, AuthMiddleware } from "./auth/auth-middleware";
import type { HealthEndpoints } from "./health";
import { parseRequestTarget } from "./request-target";
import type { RestAdapter, RestRequest } from "./transport/rest-adapter";
import { corsHeaders, errorEnvelope } from "./transport/rest-helpers";
import type { SSEAdapter } from "./transport/sse-adapter";
import type { SSEMessage } from "./transport/sse-events";
import { createWeaverError } from "./types/index";

export function createRequestHandler(
  health: HealthEndpoints,
  restAdapter: RestAdapter,
  sseAdapter: SSEAdapter,
  corsOrigins: string[] | undefined,
  authMiddleware?: AuthMiddleware,
) {
  return async function handleRequest(
    req: Request,
    res: Response,
  ): Promise<void> {
    const host = req.get("host") ?? "localhost";
    const rawTarget = req.originalUrl ?? req.url;
    const target = parseRequestTarget(rawTarget, `${req.protocol}://${host}`);
    if (!target.success) {
      if (isRawRestTarget(rawTarget)) {
        applyOuterRestError(
          res,
          outerRestError(400, "VALIDATION_ERROR", "invalid request target"),
        );
      } else {
        res.status(400).json({ error: "invalid request target" });
      }
      return;
    }
    const { pathname, query, url } = target;
    const method = req.method;

    if (pathname === "/healthz" || pathname === "/readyz") {
      const result =
        pathname === "/healthz" ? health.healthz() : health.readyz();
      res.status(result.status).json(result.body);
      return;
    }
    if (pathname === "/v1/events" && method === "GET") {
      await handleSSE(url, req, res, sseAdapter, corsOrigins);
      return;
    }
    if (pathname.startsWith("/v1/")) {
      await handleRest(
        req,
        res,
        pathname,
        query,
        method,
        restAdapter,
        authMiddleware,
      );
      return;
    }
    res.status(404).json({ error: "not found" });
  };
}

function isRawRestTarget(target: string): boolean {
  const path = target.split("?", 1)[0];
  if (path === "/v1/events" || path?.startsWith("/v1/events/")) return false;
  return path === "/v1" || path?.startsWith("/v1/") === true;
}

async function handleRest(
  req: Request,
  res: Response,
  pathname: string,
  query: Record<string, string>,
  method: string,
  restAdapter: RestAdapter,
  authMiddleware?: AuthMiddleware,
): Promise<void> {
  const headers = requestHeaders(req);
  const authResult = await authenticateRestRequest(
    method,
    headers,
    authMiddleware,
  );
  if (isHttpErrorResponse(authResult)) {
    applyOuterRestError(res, authResult);
    return;
  }
  const restRequest: RestRequest = {
    params: {},
    query,
    body: method === "GET" || method === "HEAD" ? undefined : req.body,
    headers,
    ...(authResult ? { authContext: authResult } : {}),
  };
  const response = await restAdapter.handleRequest(
    method,
    pathname,
    restRequest,
  );
  applyResponse(res, {
    status: response.status,
    body: response.body,
    headers: response.headers ?? { "content-type": "application/json" },
  });
}

function requestHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(",");
    }
  }
  return headers;
}

async function handleSSE(
  url: URL,
  req: Request,
  res: Response,
  sseAdapter: SSEAdapter,
  corsOrigins: string[] | undefined,
): Promise<void> {
  const client = await sseAdapter.createClient(sseClientOptions(url));
  res.status(200);
  if (corsOrigins?.length) {
    const headers = corsHeaders(corsOrigins, req.headers.origin);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  for (const message of client.messages) res.write(message);

  const originalSend = client.send.bind(client);
  Object.defineProperty(client, "send", {
    value(message: SSEMessage) {
      originalSend(message);
      const formatted = client.messages[client.messages.length - 1];
      if (formatted) res.write(formatted);
    },
    writable: true,
    configurable: true,
  });
  req.on("close", () => {
    client.close();
    res.end();
  });
}

function sseClientOptions(url: URL): Record<string, string> {
  const options: Record<string, string> = {};
  const prefix = url.searchParams.get("prefix");
  const scope = url.searchParams.get("scope");
  const since = url.searchParams.get("since");
  if (prefix) options.prefix = prefix;
  if (scope) options.scope = scope;
  if (since) options.since = since;
  return options;
}

interface HttpErrorResponse {
  status: number;
  body: ReturnType<typeof errorEnvelope>;
}

function isWriteMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function unauthorized(message: string): HttpErrorResponse {
  return outerRestError(401, "UNAUTHORIZED", message);
}

function outerRestError(
  status: number,
  code: "UNAUTHORIZED" | "VALIDATION_ERROR",
  message: string,
): HttpErrorResponse {
  return {
    status,
    body: errorEnvelope(createWeaverError(code, message), ""),
  };
}

function isHttpErrorResponse(
  value: AuthContext | HttpErrorResponse | undefined,
): value is HttpErrorResponse {
  return value !== undefined && "status" in value;
}

function applyResponse(
  res: Response,
  response: { status: number; body: unknown; headers?: Record<string, string> },
): void {
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    res.setHeader(key, value);
  }
  res.status(response.status).json(response.body);
}

function applyOuterRestError(res: Response, response: HttpErrorResponse): void {
  res.status(response.status);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(response.body));
}

async function authenticateRestRequest(
  method: string,
  headers: Record<string, string>,
  authMiddleware?: AuthMiddleware,
): Promise<AuthContext | HttpErrorResponse | undefined> {
  if (!authMiddleware) return undefined;
  const token = authMiddleware.extractToken(headers);
  if (!token && !isWriteMethod(method)) return undefined;
  try {
    return await authMiddleware.authenticate(token);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return unauthorized(message);
  }
}
