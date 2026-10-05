import { createConfigurationService } from "@weaver-conf/config-service";
import {
  type ConfigurationAuthorityController,
  createWeaverError,
  type HydratedConfigurationService,
} from "@weaver-conf/config-types";
import { createAuthMiddleware } from "./auth/auth-middleware";
import { createJwtValidator } from "./auth/jwt-validator";
import { captureAuthorityRegistryLoader } from "./core/authority-registry-bootstrap";
import { createHealthEndpoints, type HealthEndpoints } from "./health";
import { startHttpServer } from "./http-server";
import type { WeaverServer } from "./server";
import {
  borrowAuthorityProviders,
  createAuthorityLifecycle,
} from "./server-authority-lifecycle";
import { resolveAuthorityOptions } from "./server-authority-options";
import { createRequestHandler } from "./server-request-handler";
import { createAuthorityRestAdapter } from "./transport/authority-rest-adapter";
import { authorityDiagnostic } from "./transport/authority-rest-principal";
import { sanitizedAuthorityError } from "./transport/authority-rest-response";

export async function startAuthorityServer(
  input: unknown,
): Promise<WeaverServer> {
  const options = resolveAuthorityOptions(input);
  const { authority } = options;
  const loadRegistry = captureAuthorityRegistryLoader(
    authority.configuration,
    authority.registry,
    options.schemaIdentityMaxPageSize,
  );
  const borrowed = borrowAuthorityProviders(authority.configuration);
  const lifecycle = createAuthorityLifecycle(borrowed.hooks);
  try {
    let controller: ConfigurationAuthorityController | undefined;
    const registry = await loadRegistry();
    const root = await createConfigurationService(borrowed.configuration, {
      registry,
      authConfig: authority.authConfig,
      hostAuthority: authority.hostAuthority,
      writers: authority.writers,
      ...(authority.now ? { now: authority.now } : {}),
      ...(authority.audit ? { audit: authority.audit } : {}),
      onAuthorityReady(value) {
        controller = value;
      },
    });
    lifecycle.attachRoot(root);
    if (!controller)
      throw createWeaverError(
        "INTERNAL_ERROR",
        "Authority initialization failed",
      );
    return await listen(options, root, controller, lifecycle);
  } catch (error) {
    const safe = sanitizedAuthorityError(error);
    try {
      await lifecycle.close();
    } catch {
      authorityDiagnostic();
    }
    throw createWeaverError(safe.code, safe.message);
  }
}

async function listen(
  options: ReturnType<typeof resolveAuthorityOptions>,
  root: HydratedConfigurationService,
  controller: ConfigurationAuthorityController,
  lifecycle: ReturnType<typeof createAuthorityLifecycle>,
): Promise<WeaverServer> {
  const assertOpen = () => {
    if (lifecycle.closing)
      throw createWeaverError("DISPOSED", "Authority is closed");
  };
  const health = authorityHealth(root, () => lifecycle.closing);
  const adapter = createAuthorityRestAdapter(
    options.authority,
    controller,
    assertOpen,
    options.corsOrigins,
  );
  const server = await startHttpServer({
    port: options.port,
    handleRequest: withoutAutomaticEtags(
      createRequestHandler(
        health,
        adapter,
        undefined,
        options.corsOrigins,
        authorityAuthentication(options.jwtSecret),
      ),
    ),
  });
  lifecycle.attachServer(server);
  health.setReady(true);
  return {
    port: server.port,
    authEnabled: true,
    get isReady() {
      return health.readyz().status === 200;
    },
    close: lifecycle.close,
  };
}

function authorityAuthentication(secret: string) {
  const middleware = createAuthMiddleware({
    jwtValidator: createJwtValidator({ publicKeyOrSecret: secret }),
    adminRoles: [],
  });
  return {
    ...middleware,
    async authenticate(token: string | undefined) {
      try {
        return await middleware.authenticate(token);
      } catch {
        throw createWeaverError("UNAUTHORIZED", "Authentication required");
      }
    },
  };
}

function withoutAutomaticEtags(
  handler: ReturnType<typeof createRequestHandler>,
) {
  const wrapped: typeof handler = async (request, response) => {
    // This Express app belongs only to this authority server. Error responses
    // must not acquire Express's body-derived ETag in place of a core revision.
    request.app.disable("etag");
    await handler(request, response);
  };
  return wrapped;
}

function authorityHealth(
  root: HydratedConfigurationService,
  closing: () => boolean,
): HealthEndpoints {
  const health = createHealthEndpoints();
  return {
    ...health,
    readyz() {
      const initial = health.readyz();
      if (closing())
        return {
          status: 503,
          body: { status: "unavailable", uptime: initial.body.uptime },
        };
      try {
        if (root.mode !== "live")
          return {
            status: 503,
            body: { status: "degraded", uptime: initial.body.uptime },
          };
        return initial;
      } catch {
        return {
          status: 503,
          body: { status: "unavailable", uptime: initial.body.uptime },
        };
      }
    },
  };
}
