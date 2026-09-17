import type { AuditService } from "./audit/audit-service";
import type { WeaverConfigService } from "./core/config-service-types";
import type { SchemaRegistry } from "./core/schema-registry";
import type { ScopeManager } from "./core/scope-manager";
import { createServerAuth } from "./server-auth";
import { createRestAdapter } from "./transport/rest-adapter";

interface ServerTransportOptions {
  readonly jwtSecret?: string | undefined;
  readonly adminRoles: string[];
  readonly environment: string;
  readonly corsOrigins?: string[] | undefined;
  readonly auditService?: AuditService | undefined;
}

export async function createServerRest(
  config: ServerTransportOptions,
  configService: WeaverConfigService,
  schemaRegistry: SchemaRegistry,
  scopeManager: ScopeManager,
  runtime?: import("./server-runtime").WeaverRuntime,
) {
  const { authGate, authMiddleware } = createServerAuth(config, configService);
  const restAdapter = createRestAdapter({
    configService,
    schemaRegistry,
    scopeManager,
    ...(config.corsOrigins ? { corsOrigins: config.corsOrigins } : {}),
    ...(authGate ? { authGate } : {}),
    ...(config.auditService ? { auditService: config.auditService } : {}),
    ...(runtime ? { runtime } : {}),
  });
  return { restAdapter, authMiddleware };
}
