import { withAuth } from "@weaver-conf/config-auth";
import type {
  ConfigurationStorageProvider,
  WeaverConfig,
} from "@weaver-conf/config-types";
import type { Request, Response } from "express";
import type { AuditService } from "./audit/audit-service";
import type { AuthContext, AuthMiddleware } from "./auth/auth-middleware";
import { createAuthMiddleware } from "./auth/auth-middleware";
import { createJwtValidator } from "./auth/jwt-validator";
import { resolveServerBootstrap } from "./bootstrap/server-bootstrap";
import { createWeaverConfigService } from "./core/config-service";
import { disposeRuntimeResolutionContexts } from "./core/runtime-resolution-contexts";
import { createPersistentSchemaRegistry } from "./core/schema-registry";
import type { HealthEndpoints } from "./health";
import { createHealthEndpoints } from "./health";
import { type HttpServer, startHttpServer } from "./http-server";
import { parseServerEnv } from "./server-env";
import { createShutdownManager } from "./shutdown";
import type { AuthGate } from "./transport/auth-gate";
import { createAuthGate } from "./transport/auth-gate";
import type { RestAdapter, RestRequest } from "./transport/rest-adapter";
import { createRestAdapter } from "./transport/rest-adapter";
import { corsHeaders } from "./transport/rest-helpers";
import type { SSEAdapter } from "./transport/sse-adapter";
import { createSSEAdapter } from "./transport/sse-adapter";
import type { SSEMessage } from "./transport/sse-events";

type BootstrapResolver = typeof resolveServerBootstrap;
export interface WeaverServerOptions {
  port?: number;
  repoUrl?: string;
  environment?: string;
  gitToken?: string;
  mongoUri?: string;
  jwtSecret?: string;
  adminRoles?: string[];
  corsOrigins?: string[];
  providers?: ConfigurationStorageProvider[];
  auditService?: AuditService;
}
export interface WeaverServer {
  readonly port: number;
  readonly isReady: boolean;
  readonly authEnabled: boolean;
  close(): Promise<void>;
}

function resolveOptions(options?: WeaverServerOptions) {
  const env = parseServerEnv(process.env);
  return {
    port: options?.port ?? env.WEAVER_PORT ?? 3399,
    repoUrl: options?.repoUrl ?? env.WEAVER_CONFIG_REPO ?? "",
    environment:
      options?.environment ?? env.WEAVER_ENVIRONMENT ?? "development",
    gitToken: options?.gitToken ?? env.WEAVER_GIT_TOKEN,
    mongoUri: options?.mongoUri ?? env.WEAVER_MONGO_URI,
    jwtSecret: options?.jwtSecret ?? env.WEAVER_JWT_SECRET,
    adminRoles: options?.adminRoles ?? ["admin"],
    corsOrigins: options?.corsOrigins,
    providers: options?.providers,
    auditService: options?.auditService,
  };
}
function createRequestHandler(
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
    const url = new URL(
      req.originalUrl ?? req.url,
      `${req.protocol}://${host}`,
    );
    const method = req.method;

    if (url.pathname === "/healthz") {
      const result = health.healthz();
      res.status(result.status).json(result.body);
      return;
    }

    if (url.pathname === "/readyz") {
      const result = health.readyz();
      res.status(result.status).json(result.body);
      return;
    }

    if (url.pathname === "/v1/events" && method === "GET") {
      await handleSSE(url, req, res, sseAdapter, corsOrigins);
      return;
    }

    if (url.pathname.startsWith("/v1/")) {
      await handleRest(req, res, url, method, restAdapter, authMiddleware);
      return;
    }

    res.status(404).json({ error: "not found" });
  };
}
async function handleRest(
  req: Request,
  res: Response,
  url: URL,
  method: string,
  restAdapter: RestAdapter,
  authMiddleware?: AuthMiddleware,
): Promise<void> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const body = method === "GET" || method === "HEAD" ? undefined : req.body;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      headers[key] = value.join(",");
    }
  }

  const authResult = await authenticateRestRequest(
    method,
    headers,
    authMiddleware,
  );
  if (isHttpErrorResponse(authResult)) {
    applyResponse(res, authResult);
    return;
  }

  const restRequest: RestRequest = {
    params: {},
    query,
    body,
    headers,
    ...(authResult ? { authContext: authResult } : {}),
  };

  const restResponse = await restAdapter.handleRequest(
    method,
    url.pathname,
    restRequest,
  );

  applyResponse(res, {
    status: restResponse.status,
    body: restResponse.body,
    headers: restResponse.headers ?? { "content-type": "application/json" },
  });
}

async function handleSSE(
  url: URL,
  req: Request,
  res: Response,
  sseAdapter: SSEAdapter,
  corsOrigins: string[] | undefined,
): Promise<void> {
  const clientOptions: Record<string, string> = {};
  const prefix = url.searchParams.get("prefix");
  const scope = url.searchParams.get("scope");
  const since = url.searchParams.get("since");
  if (prefix) clientOptions.prefix = prefix;
  if (scope) clientOptions.scope = scope;
  if (since) clientOptions.since = since;

  const client = await sseAdapter.createClient(clientOptions);

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

  for (const msg of client.messages) {
    res.write(msg);
  }

  const originalSend = client.send.bind(client);
  Object.defineProperty(client, "send", {
    value(message: SSEMessage) {
      originalSend(message);
      const formatted = client.messages[client.messages.length - 1];
      if (!formatted) {
        return;
      }
      res.write(formatted);
    },
    writable: true,
    configurable: true,
  });

  req.on("close", () => {
    client.close();
    res.end();
  });
}

function isWriteMethod(method: string): boolean {
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

interface HttpErrorResponse {
  status: number;
  body: { error: { code: string; message: string } };
  headers: Record<string, string>;
}

function unauthorized(message: string): HttpErrorResponse {
  return {
    status: 401,
    body: { error: { code: "UNAUTHORIZED", message } },
    headers: { "content-type": "application/json" },
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
  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      res.setHeader(key, value);
    }
  }
  res.status(response.status).json(response.body);
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unauthorized";
    return unauthorized(message);
  }
}

export async function startWeaverServer(
  options?: WeaverServerOptions,
): Promise<WeaverServer> {
  return startWeaverServerInternal(options, resolveServerBootstrap);
}

export async function startWeaverServerInternal(
  options: WeaverServerOptions | undefined,
  resolveBootstrap: BootstrapResolver,
): Promise<WeaverServer> {
  const config = resolveOptions(options);

  const health = createHealthEndpoints();
  const shutdownManager = createShutdownManager({ drainTimeoutMs: 10_000 });

  const bootstrapResult = await resolveBootstrap(config);
  const inputProviders = bootstrapResult.providers;

  let configService: Awaited<ReturnType<typeof createWeaverConfigService>>;
  try {
    configService = await createWeaverConfigService({
      providers: inputProviders,
      environment: config.environment,
    });
  } catch (err) {
    await bootstrapResult.dispose();
    throw err;
  }

  let sseAdapter: SSEAdapter | undefined;
  let server: HttpServer | undefined;

  try {
    let authGate: AuthGate | undefined;
    let authMiddleware: AuthMiddleware | undefined;

    if (config.jwtSecret) {
      const jwtValidator = createJwtValidator({
        publicKeyOrSecret: config.jwtSecret,
      });

      authMiddleware = createAuthMiddleware({
        jwtValidator,
        adminRoles: config.adminRoles,
      });

      const layerRanks = new Map([
        ["platform", 0],
        ["tenant", 1],
        ["session", 2],
      ]);
      const weaverConfig = {
        layers: [],
        layerNames: [...layerRanks.keys()],
        rankMap: layerRanks,
        getRank: (layer: string) => layerRanks.get(layer) ?? -1,
        getLayer: () => undefined,
        getLayersByType: () => [],
      } satisfies WeaverConfig;

      const authFunctions = withAuth({
        weaverConfig,
        visibilityRoles: {
          admin: new Set(config.adminRoles),
          platform: new Set([...config.adminRoles, "platform"]),
        },
        layerWritePolicies: [
          { layer: "platform", allowedRoles: config.adminRoles },
        ],
        dynamicScopeRoles: new Set(config.adminRoles),
      });

      authGate = createAuthGate({
        authFunctions,
        mapContext: (authCtx) => ({
          userId:
            authCtx.identity.userId ??
            authCtx.identity.serviceId ??
            "anonymous",
          roles: authCtx.identity.roles ?? [],
          sessionMode: undefined,
        }),
      });
    }

    const restAdapterOptions: {
      configService: typeof configService;
      schemaRegistry: Awaited<
        ReturnType<typeof createPersistentSchemaRegistry>
      >;
      corsOrigins?: string[];
      authGate?: AuthGate;
      auditService?: AuditService;
    } = {
      configService,
      schemaRegistry: await createPersistentSchemaRegistry({
        configService,
        environment: config.environment,
      }),
    };
    if (config.corsOrigins) {
      restAdapterOptions.corsOrigins = config.corsOrigins;
    }
    if (authGate) {
      restAdapterOptions.authGate = authGate;
    }
    if (config.auditService) {
      restAdapterOptions.auditService = config.auditService;
    }

    const restAdapter = createRestAdapter(restAdapterOptions);

    sseAdapter = createSSEAdapter({ configService });
    sseAdapter.startCheckpointTimer();

    const handleRequest = createRequestHandler(
      health,
      restAdapter,
      sseAdapter,
      config.corsOrigins,
      authMiddleware,
    );

    server = await startHttpServer({
      port: config.port,
      handleRequest,
    });
    const activeSseAdapter = sseAdapter;
    const activeServer = server;

    health.setDegradedInfo({
      degradedProviders: configService.degradedProviders,
      totalProviders: inputProviders.length,
    });
    health.setReady(true);

    shutdownManager.onShutdown(async () => {
      health.setReady(false);
      await configService.flush();
      activeSseAdapter.stopCheckpointTimer();
      activeSseAdapter.closeAll();
      await activeServer.stop();
      await disposeRuntimeResolutionContexts(configService);
      await bootstrapResult.dispose();
    });

    return {
      get port() {
        return activeServer.port;
      },
      get isReady() {
        return health.readyz().status === 200;
      },
      get authEnabled() {
        return authMiddleware !== undefined;
      },
      async close() {
        await shutdownManager.shutdown();
      },
    };
  } catch (err) {
    health.setReady(false);
    sseAdapter?.stopCheckpointTimer();
    sseAdapter?.closeAll();
    await server?.stop();
    await disposeRuntimeResolutionContexts(configService);
    await bootstrapResult.dispose();
    throw err;
  }
}
