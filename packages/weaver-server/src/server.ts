import { withAuth } from "@weaver-conf/config-auth";
import type {
  ConfigurationStorageProvider,
  WeaverConfig,
} from "@weaver-conf/config-types";
import type { AuthMiddleware } from "./auth/auth-middleware";
import { createAuthMiddleware } from "./auth/auth-middleware";
import { createJwtValidator } from "./auth/jwt-validator";
import { resolveServerBootstrap } from "./bootstrap/server-bootstrap";
import { createWeaverConfigService } from "./core/config-service";
import { createPersistentSchemaRegistry } from "./core/schema-registry";
import { createHealthEndpoints } from "./health";
import { type HttpServer, startHttpServer } from "./http-server";
import { parseServerEnv } from "./server-env";
import { createRequestHandler } from "./server-request-handler";
import { createShutdownManager } from "./shutdown";
import type { AuthGate } from "./transport/auth-gate";
import { createAuthGate } from "./transport/auth-gate";
import { createRestAdapter } from "./transport/rest-adapter";
import type { SSEAdapter } from "./transport/sse-adapter";
import { createSSEAdapter } from "./transport/sse-adapter";

type BootstrapResolver = typeof resolveServerBootstrap;
type BootstrapResult = Awaited<ReturnType<BootstrapResolver>>;
type ConfigService = Awaited<ReturnType<typeof createWeaverConfigService>>;
type ResolvedOptions = ReturnType<typeof resolveOptions>;

interface ServerAuth {
  readonly authGate?: AuthGate | undefined;
  readonly authMiddleware?: AuthMiddleware | undefined;
}

interface ServerRuntime extends ServerAuth {
  readonly server: HttpServer;
  readonly sseAdapter: SSEAdapter;
}

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
  };
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
  const configService = await initializeConfigService(config, bootstrapResult);
  try {
    const runtime = await createServerRuntime(config, configService, health);
    registerShutdown(
      runtime,
      health,
      shutdownManager,
      configService,
      bootstrapResult,
    );
    return serverHandle(runtime, health, shutdownManager);
  } catch (error) {
    health.setReady(false);
    await bootstrapResult.dispose();
    throw error;
  }
}

async function initializeConfigService(
  config: ResolvedOptions,
  bootstrapResult: BootstrapResult,
): Promise<ConfigService> {
  try {
    return await createWeaverConfigService({
      providers: bootstrapResult.providers,
      environment: config.environment,
    });
  } catch (error) {
    await bootstrapResult.dispose();
    throw error;
  }
}

async function createServerRuntime(
  config: ResolvedOptions,
  configService: ConfigService,
  health: ReturnType<typeof createHealthEndpoints>,
): Promise<ServerRuntime> {
  const auth = createServerAuth(config);
  const restAdapter = await createConfiguredRestAdapter(
    config,
    configService,
    auth.authGate,
  );
  const sseAdapter = createSSEAdapter({ configService });
  sseAdapter.startCheckpointTimer();
  try {
    const server = await startHttpServer({
      port: config.port,
      handleRequest: createRequestHandler(
        health,
        restAdapter,
        sseAdapter,
        config.corsOrigins,
        auth.authMiddleware,
      ),
    });
    health.setDegradedInfo({
      degradedProviders: configService.degradedProviders,
      totalProviders: configService.providers.length,
    });
    health.setReady(true);
    return { ...auth, server, sseAdapter };
  } catch (error) {
    sseAdapter.stopCheckpointTimer();
    sseAdapter.closeAll();
    throw error;
  }
}

async function createConfiguredRestAdapter(
  config: ResolvedOptions,
  configService: ConfigService,
  authGate: AuthGate | undefined,
) {
  return createRestAdapter({
    configService,
    schemaRegistry: await createPersistentSchemaRegistry({
      configService,
      environment: config.environment,
    }),
    ...(config.corsOrigins ? { corsOrigins: config.corsOrigins } : {}),
    ...(authGate ? { authGate } : {}),
  });
}

function createServerAuth(config: ResolvedOptions): ServerAuth {
  if (!config.jwtSecret) return {};
  const authMiddleware = createAuthMiddleware({
    jwtValidator: createJwtValidator({ publicKeyOrSecret: config.jwtSecret }),
    adminRoles: config.adminRoles,
  });
  const authFunctions = withAuth({
    weaverConfig: authWeaverConfig(),
    visibilityRoles: {
      admin: new Set(config.adminRoles),
      platform: new Set([...config.adminRoles, "platform"]),
    },
    layerWritePolicies: [
      { layer: "platform", allowedRoles: config.adminRoles },
    ],
    dynamicScopeRoles: new Set(config.adminRoles),
  });
  const authGate = createAuthGate({
    authFunctions,
    mapContext: (context) => ({
      userId:
        context.identity.userId ?? context.identity.serviceId ?? "anonymous",
      roles: context.identity.roles ?? [],
      sessionMode: undefined,
    }),
  });
  return { authGate, authMiddleware };
}

function authWeaverConfig(): WeaverConfig {
  const rankMap = new Map([
    ["platform", 0],
    ["tenant", 1],
    ["session", 2],
  ]);
  return {
    layers: [],
    layerNames: [...rankMap.keys()],
    rankMap,
    getRank: (layer: string) => rankMap.get(layer) ?? -1,
    getLayer: () => undefined,
    getLayersByType: () => [],
  };
}

function registerShutdown(
  runtime: ServerRuntime,
  health: ReturnType<typeof createHealthEndpoints>,
  shutdownManager: ReturnType<typeof createShutdownManager>,
  configService: ConfigService,
  bootstrapResult: BootstrapResult,
): void {
  shutdownManager.onShutdown(async () => {
    health.setReady(false);
    await configService.flush();
    runtime.sseAdapter.stopCheckpointTimer();
    runtime.sseAdapter.closeAll();
    await runtime.server.stop();
    await bootstrapResult.dispose();
  });
}

function serverHandle(
  runtime: ServerRuntime,
  health: ReturnType<typeof createHealthEndpoints>,
  shutdownManager: ReturnType<typeof createShutdownManager>,
): WeaverServer {
  return {
    get port() {
      return runtime.server.port;
    },
    get isReady() {
      return health.readyz().status === 200;
    },
    get authEnabled() {
      return runtime.authMiddleware !== undefined;
    },
    async close() {
      await shutdownManager.shutdown();
    },
  };
}
