import type { Request, Response } from "express";
import type { AuthContext, AuthMiddleware } from "./auth/auth-middleware";
import type { HealthEndpoints } from "./health";
import type { WeaverRuntime } from "./server-runtime";
import { handleSSE } from "./server-sse";
import type { RestAdapter, RestRequest } from "./transport/rest-adapter";
import type { SSEAdapter } from "./transport/sse-adapter";

export function createRuntimeRequestHandler(
  runtime: WeaverRuntime,
  health: HealthEndpoints,
  rest: RestAdapter,
  sse: SSEAdapter,
  auth: AuthMiddleware,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const url = new URL(
      req.originalUrl ?? req.url,
      `${req.protocol}://${req.get("host") ?? "localhost"}`,
    );
    health.setReady(runtime.state === "ready");
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      const result =
        url.pathname === "/healthz" ? health.healthz() : health.readyz();
      res.status(result.status).json(result.body);
      return;
    }
    const upgradeAdmin = [
      "/v1/admin/upgrades/plan",
      "/v1/admin/upgrades/apply",
      "/v1/admin/upgrades/recover",
      "/v1/admin/upgrades/status",
    ].includes(url.pathname);
    if (
      url.pathname.startsWith("/v1/") &&
      runtime.state !== "ready" &&
      !upgradeAdmin
    ) {
      res.status(503).json({
        error: {
          code: "MAINTENANCE",
          message: "Runtime is not accepting application traffic",
        },
      });
      return;
    }
    if (url.pathname === "/v1/events" && req.method === "GET") {
      await handleSSE(
        url,
        req,
        res,
        sse,
        runtime.settings.corsOrigins
          ? [...runtime.settings.corsOrigins]
          : undefined,
      );
      return;
    }
    if (url.pathname.startsWith("/v1/")) {
      await handleRest(req, res, url, rest, auth);
      return;
    }
    res.status(404).json({ error: "not found" });
  };
}
async function handleRest(
  req: Request,
  res: Response,
  url: URL,
  rest: RestAdapter,
  auth: AuthMiddleware,
): Promise<void> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const headers = requestHeaders(req);
  let context: AuthContext | undefined;
  try {
    const token = auth.extractToken(headers);
    if (
      req.method !== "OPTIONS" &&
      (token || !["GET", "HEAD"].includes(req.method))
    )
      context = await auth.authenticate(token);
  } catch {
    res
      .status(401)
      .json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    return;
  }
  const request: RestRequest = {
    params: {},
    query,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    headers,
    ...(context ? { authContext: context } : {}),
  };
  const response = await rest.handleRequest(req.method, url.pathname, request);
  for (const [key, value] of Object.entries(
    response.headers ?? { "content-type": "application/json" },
  ))
    res.setHeader(key, value);
  res.status(response.status).json(response.body);
}
function requestHeaders(req: Request): Record<string, string> {
  return Object.fromEntries(
    Object.entries(req.headers).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[key, value]]
        : Array.isArray(value)
          ? [[key, value.join(",")]]
          : [],
    ),
  );
}
