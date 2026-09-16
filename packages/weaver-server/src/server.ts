import { runIndependentCleanup } from "@weaver-conf/config-engine";
import {
  type BootstrapSeed,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { AuditService } from "./audit/audit-service";
import type { BootstrapRuntimeOptions } from "./bootstrap/initialize";
import { createHealthEndpoints } from "./health";
import { type HttpServer, startHttpServer } from "./http-server";
import { createRuntimeRequestHandler } from "./server-http";
import { openWeaverRuntime, type WeaverRuntime } from "./server-runtime";
import { createServerRest } from "./server-transport";
import { createSSEAdapter, type SSEAdapter } from "./transport/sse-adapter";

export interface WeaverServerOptions extends BootstrapRuntimeOptions {
  readonly seed: BootstrapSeed;
  readonly auditService?: AuditService;
}
export interface WeaverServer {
  readonly port: number;
  readonly isReady: boolean;
  readonly authEnabled: true;
  readonly runtime: WeaverRuntime;
  close(): Promise<void>;
}
/** The standalone server has one external authority: its validated seed. */
export async function startWeaverServer(
  options: WeaverServerOptions,
): Promise<WeaverServer> {
  assertServerOptions(options);
  const runtime = await openWeaverRuntime(options.seed, options);
  let sse: SSEAdapter | undefined;
  let http: HttpServer | undefined;
  try {
    const health = createHealthEndpoints();
    const { restAdapter, authMiddleware } = await configuredRest(
      runtime,
      options,
    );
    if (!authMiddleware)
      throw createWeaverError(
        "CONFIG_NOT_READY",
        "Configured server authentication is unavailable",
      );
    sse = createSSEAdapter({ configService: runtime.configService });
    if (runtime.state === "ready") sse.startCheckpointTimer();
    runtime.onMaintenance(() => {
      health.setReady(false);
    });
    http = await startHttpServer({
      port: runtime.settings.port,
      handleRequest: createRuntimeRequestHandler(
        runtime,
        health,
        restAdapter,
        sse,
        authMiddleware,
      ),
    });
    health.setReady(runtime.state === "ready");
    return serverHandle(runtime, sse, http);
  } catch (error) {
    await closeResources(runtime, sse, http, error);
    throw error;
  }
}
function configuredRest(runtime: WeaverRuntime, options: WeaverServerOptions) {
  return createServerRest(
    {
      jwtSecret: runtime.authenticationKey,
      adminRoles: [...runtime.settings.auth.adminRoles],
      environment: options.seed.environment,
      ...(runtime.settings.corsOrigins
        ? { corsOrigins: [...runtime.settings.corsOrigins] }
        : {}),
      ...(options.auditService ? { auditService: options.auditService } : {}),
    },
    runtime.configService,
    runtime.schemaRegistry,
    runtime.scopeManager,
    runtime,
  );
}
function assertServerOptions(options: WeaverServerOptions): void {
  if (
    !options ||
    Object.keys(options).some(
      (key) =>
        ![
          "seed",
          "credentials",
          "factories",
          "secretBackend",
          "auditService",
        ].includes(key),
    ) ||
    typeof options.credentials?.resolveCredential !== "function"
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Standalone startup requires seed and injected credentials; obsolete server options are unsupported",
    );
}
function serverHandle(
  runtime: WeaverRuntime,
  sse: SSEAdapter,
  http: HttpServer,
): WeaverServer {
  let closing: Promise<void> | undefined;
  return {
    get port() {
      return http.port;
    },
    get isReady() {
      return runtime.state === "ready";
    },
    authEnabled: true,
    runtime,
    close() {
      closing ??= closeResources(runtime, sse, http);
      return closing;
    },
  };
}
async function closeResources(
  runtime: WeaverRuntime,
  sse?: SSEAdapter,
  http?: HttpServer,
  primary?: unknown,
): Promise<void> {
  await runIndependentCleanup(
    [
      { name: "runtime", run: () => runtime.close() },
      {
        name: "SSE",
        run: async () => {
          sse?.stopCheckpointTimer();
          sse?.closeAll();
        },
      },
      {
        name: "HTTP",
        run: async () => {
          await http?.stop();
        },
      },
    ],
    primary,
  );
}
