import { withAuth } from "@weaver-conf/config-auth";
import { createWeaverError } from "@weaver-conf/config-types";
import { createAuthMiddleware } from "./auth/auth-middleware";
import { createJwtValidator } from "./auth/jwt-validator";
import type { WeaverConfigService } from "./core/config-service-types";
import { createAuthGate } from "./transport/auth-gate";

export function createServerAuth(
  config: { jwtSecret?: string | undefined; adminRoles: string[] },
  service: WeaverConfigService,
) {
  if (!config.jwtSecret)
    return { authGate: undefined, authMiddleware: undefined };
  const weaverConfig = service.layout;
  if (!weaverConfig)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Compiled layout is unavailable",
    );
  const authMiddleware = createAuthMiddleware({
    jwtValidator: createJwtValidator({ publicKeyOrSecret: config.jwtSecret }),
    adminRoles: config.adminRoles,
  });
  const authFunctions = withAuth({
    weaverConfig,
    visibilityRoles: {
      admin: new Set(config.adminRoles),
      platform: new Set(config.adminRoles),
      ...Object.fromEntries(
        weaverConfig.layerNames.map((layer) => [
          layer,
          new Set(config.adminRoles),
        ]),
      ),
    },
    layerWritePolicies: weaverConfig.layerNames.map((layer) => ({
      layer,
      allowedRoles: config.adminRoles,
    })),
    dynamicScopeRoles: new Set(config.adminRoles),
  });
  return {
    authMiddleware,
    authGate: createAuthGate({
      authFunctions,
      mapContext: (authCtx) => ({
        userId:
          authCtx.identity.userId ?? authCtx.identity.serviceId ?? "anonymous",
        roles: authCtx.identity.roles ?? [],
        sessionMode: undefined,
      }),
    }),
  };
}
