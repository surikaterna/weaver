// Auth gate — bridges weaver-server AuthContext to config-auth RBAC functions
import type { AuthFunctions } from "@weaver-conf/config-auth";
import type {
  ConfigurationAccessContext,
  ConfigurationPropertySchema,
} from "@weaver-conf/config-types";
import type { AuthContext } from "../auth/auth-middleware";
import { filterProtectedConfigEntries } from "../core/protected-config-paths";
import type { RestResponse } from "./rest-adapter";

export interface AuthGate {
  toAccessContext(authCtx: AuthContext): ConfigurationAccessContext;
  gateRead(
    accessCtx: ConfigurationAccessContext,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null;
  gateWrite(
    accessCtx: ConfigurationAccessContext,
    layer: string,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null;
  filterVisible(
    accessCtx: ConfigurationAccessContext,
    entries: Record<string, unknown>,
    schemaMap: Map<string, ConfigurationPropertySchema>,
  ): Record<string, unknown>;
}

export interface AuthGateOptions {
  authFunctions: AuthFunctions;
  /** Map AuthContext to ConfigurationAccessContext — caller provides the mapping logic */
  mapContext: (authCtx: AuthContext) => ConfigurationAccessContext;
}

function forbidden(message: string): RestResponse {
  return {
    status: 403,
    body: {
      data: null,
      meta: { revision: "", timestamp: new Date().toISOString() },
      error: { code: "FORBIDDEN", message },
    },
    headers: { "Content-Type": "application/json" },
  };
}

export function createAuthGate(options: AuthGateOptions): AuthGate {
  const { authFunctions, mapContext } = options;

  function toAccessContext(authCtx: AuthContext): ConfigurationAccessContext {
    return mapContext(authCtx);
  }

  function gateRead(
    accessCtx: ConfigurationAccessContext,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null {
    if (!authFunctions.canRead(accessCtx, key, schema ?? undefined)) {
      return forbidden(`Read access denied for key: ${key}`);
    }
    return null;
  }

  function gateWrite(
    accessCtx: ConfigurationAccessContext,
    layer: string,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null {
    if (!authFunctions.canWrite(accessCtx, layer, key, schema ?? undefined)) {
      return forbidden(
        `Write access denied for key: ${key} on layer: ${layer}`,
      );
    }
    return null;
  }

  function filterVisible(
    accessCtx: ConfigurationAccessContext,
    entries: Record<string, unknown>,
    schemaMap: Map<string, ConfigurationPropertySchema>,
  ): Record<string, unknown> {
    const publicEntries = filterProtectedConfigEntries(entries);
    return filterProtectedConfigEntries(
      authFunctions.filterVisibleKeys(accessCtx, publicEntries, schemaMap),
    );
  }

  return { toAccessContext, gateRead, gateWrite, filterVisible };
}
