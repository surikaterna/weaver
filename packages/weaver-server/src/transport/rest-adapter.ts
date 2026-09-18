// REST transport adapter — maps HTTP routes to WeaverConfigService

import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { ZodError } from "zod";
import type { AuthContext } from "../auth/auth-middleware";
import type { WeaverConfigService } from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { createWeaverError } from "../types/index";
import type { AuthGate } from "./auth-gate";
import {
  corsHeaders,
  errorEnvelope,
  matchPath,
  v1Headers,
} from "./rest-helpers";
import { buildRoutes } from "./rest-routes";

export type { ApiErrorResponse, ApiResponse } from "./rest-helpers";

export interface RestRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: (req: RestRequest) => Promise<RestResponse>;
}

export interface RestRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  headers: Record<string, string>;
  authContext?: AuthContext;
  schemaMap?: Map<string, ConfigurationPropertySchema>;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestAdapterOptions {
  configService: WeaverConfigService;
  schemaRegistry?: SchemaRegistry;
  scopeManager?: ScopeManager;
  corsOrigins?: string[];
  authGate?: AuthGate;
}

export interface RestAdapter {
  readonly routes: ReadonlyArray<RestRoute>;
  handleRequest(
    method: string,
    path: string,
    req: RestRequest,
  ): Promise<RestResponse>;
}

interface RouteMatch {
  route: RestRoute;
  params: Record<string, string>;
}

export function createRestAdapter(options: RestAdapterOptions): RestAdapter {
  const { configService, schemaRegistry, scopeManager, corsOrigins, authGate } =
    options;

  const routes: RestRoute[] = buildRoutes({
    configService,
    schemaRegistry,
    scopeManager,
    authGate,
  });

  function findRoute(method: string, path: string): RouteMatch | null {
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, path);
      if (params) return { route, params };
    }
    return null;
  }

  async function handleRequest(
    method: string,
    path: string,
    req: RestRequest,
  ): Promise<RestResponse> {
    if (method === "OPTIONS") {
      const rev = configService.revision;
      const responseHeaders = v1Headers(rev);

      if (corsOrigins?.length) {
        Object.assign(
          responseHeaders,
          corsHeaders(
            corsOrigins,
            req.headers.origin,
            req.headers["access-control-request-headers"],
          ),
        );
      }

      return {
        status: 204,
        body: null,
        headers: responseHeaders,
      };
    }

    const match = findRoute(method, path);
    if (!match) {
      const rev = configService.revision;
      return {
        status: 404,
        body: errorEnvelope(
          createWeaverError("NOT_FOUND", `No route: ${method} ${path}`),
          rev,
        ),
        headers: v1Headers(rev),
      };
    }

    const fullReq: RestRequest = {
      ...req,
      params: { ...req.params, ...match.params },
    };

    try {
      const response = await match.route.handler(fullReq);
      if (corsOrigins?.length) {
        response.headers = {
          ...response.headers,
          ...corsHeaders(corsOrigins, req.headers.origin),
        };
      }
      return response;
    } catch (err: unknown) {
      if (err instanceof ZodError) {
        const rev = configService.revision;
        return {
          status: 400,
          body: errorEnvelope(
            createWeaverError("VALIDATION_ERROR", "Request validation failed", {
              issues: err.issues,
            }),
            rev,
          ),
          headers: v1Headers(rev),
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      const rev = configService.revision;
      return {
        status: 500,
        body: errorEnvelope(createWeaverError("INTERNAL_ERROR", message), rev),
        headers: v1Headers(rev),
      };
    }
  }

  return { routes, handleRequest };
}
