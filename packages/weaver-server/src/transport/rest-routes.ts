// REST route definitions for config and scope endpoints

import { buildPath } from "@weaver-conf/config-engine";
import type { AuditService } from "../audit/audit-service";
import type { WeaverConfigService, WriteContext } from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { parseScopeQuery } from "../core/scope-utils";
import { createWeaverError } from "../types/index";
import type { AuthGate } from "./auth-gate";
import type { RestRequest, RestResponse, RestRoute } from "./rest-adapter";
import {
  extractExpectedRevision,
  v1Error,
  v1Response,
  writeFailureResponse,
} from "./rest-route-boundary";
import { buildSchemaRoutes } from "./rest-schema-routes";
import {
  configBatchBodySchema,
  configWriteBodySchema,
  scopeProvisionBodySchema,
} from "./rest-schemas";

export interface RouteFactoryDeps {
  configService: WeaverConfigService;
  schemaRegistry?: SchemaRegistry | undefined;
  scopeManager?: ScopeManager | undefined;
  authGate?: AuthGate | undefined;
  auditService?: AuditService | undefined;
  defaultEnvironment?: string | undefined;
}

function param(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (!value) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Missing required route parameter: ${name}`,
    );
  }
  return value;
}

function queryOpt(
  query: Record<string, string>,
  name: string,
): string | undefined {
  const v = query[name];
  return v === undefined ? undefined : v;
}

export function buildRoutes(deps: RouteFactoryDeps): RestRoute[] {
  const { configService, schemaRegistry, authGate, auditService } = deps;
  return [
    ...buildSchemaRoutes({
      configService,
      schemaRegistry,
      authGate,
      auditService,
      defaultEnvironment: deps.defaultEnvironment ?? "default",
    }),
    configListRoute(deps),
    configGetRoute(deps),
    configSetRoute(deps),
    configRemoveRoute(deps),
    configBatchRoute(deps),
    scopesRoute(deps),
    scopeValuesRoute(deps),
    scopeProvisionRoute(deps),
    scopeDeprovisionRoute(deps),
  ];
}

function configListRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, authGate } = deps;
  return {
    method: "GET",
    path: "/v1/config",
    async handler(req) {
      const scopePath = parseScopeQuery(queryOpt(req.query, "scope"));
      const snapshot = await configService.resolveAll(
        scopePath ? { scopePath } : {},
      );
      if (!authGate || !req.authContext) {
        return v1Response(configService, 200, snapshot);
      }
      const accessCtx = authGate.toAccessContext(req.authContext);
      const filtered = authGate.filterVisible(
        accessCtx,
        snapshot,
        req.schemaMap ?? new Map(),
      );
      return v1Response(configService, 200, filtered);
    },
  };
}

function configGetRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, authGate } = deps;
  return {
    method: "GET",
    path: "/v1/config/*keyPath",
    async handler(req) {
      const key = requestKey(req);
      const denied = readDenied(authGate, req, key);
      if (denied) return denied;
      if ("inspect" in req.query) {
        return v1Response(configService, 200, await configService.inspect(key));
      }
      const scopePath = parseScopeQuery(queryOpt(req.query, "scope"));
      const value = await configService.get(
        key,
        scopePath ? { scopePath } : {},
      );
      return v1Response(configService, 200, { key, value });
    },
  };
}

function configSetRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, authGate } = deps;
  return {
    method: "PUT",
    path: "/v1/config/*keyPath",
    async handler(req) {
      const key = requestKey(req);
      const layer = queryOpt(req.query, "layer") ?? "platform";
      const denied = writeDenied(authGate, req, layer, key);
      if (denied) return denied;
      const body = configWriteBodySchema.parse(req.body);
      const result = await configService.set(
        layer,
        key,
        body.value,
        requestWriteContext(req),
      );
      if (!result.success) {
        return writeFailureResponse(configService, result, "Write failed");
      }
      return v1Response(configService, 200, result);
    },
  };
}

function configRemoveRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, authGate } = deps;
  return {
    method: "DELETE",
    path: "/v1/config/*keyPath",
    async handler(req) {
      const key = requestKey(req);
      const layer = queryOpt(req.query, "layer") ?? "platform";
      const denied = writeDenied(authGate, req, layer, key);
      if (denied) return denied;
      const result = await configService.remove(
        layer,
        key,
        requestWriteContext(req),
      );
      if (!result.success) {
        return writeFailureResponse(configService, result, "Remove failed");
      }
      return v1Response(configService, 200, result);
    },
  };
}

function configBatchRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, authGate } = deps;
  return {
    method: "PATCH",
    path: "/v1/config",
    async handler(req) {
      const layer = queryOpt(req.query, "layer") ?? "platform";
      const entries = configBatchBodySchema.parse(req.body).entries;
      for (const key of Object.keys(entries)) {
        const denied = writeDenied(authGate, req, layer, key);
        if (denied) return denied;
      }
      const result = await configService.setMany(
        layer,
        entries,
        requestWriteContext(req),
      );
      if (!result.success) {
        return writeFailureResponse(
          configService,
          result,
          "Batch write failed",
        );
      }
      return v1Response(configService, 200, {
        ...result,
        written: Object.keys(entries).length,
      });
    },
  };
}

function scopesRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, scopeManager } = deps;
  return {
    method: "GET",
    path: "/v1/scopes",
    async handler() {
      const definitions = scopeManager?.listScopes() ?? [];
      return v1Response(configService, 200, { definitions });
    },
  };
}

function scopeValuesRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, scopeManager } = deps;
  return {
    method: "GET",
    path: "/v1/scopes/:scopeId",
    async handler(req) {
      const values =
        scopeManager?.listScopeValues(param(req.params, "scopeId")) ?? [];
      return v1Response(configService, 200, { values });
    },
  };
}

function scopeProvisionRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, scopeManager } = deps;
  return {
    method: "POST",
    path: "/v1/admin/scopes/:scopeId",
    async handler(req) {
      if (!scopeManager) return missingScopeManager(configService);
      const denied = scopeWriteDenied(deps, req);
      if (denied) return denied;
      const body = scopeProvisionBodySchema.parse(req.body);
      const result = await scopeManager.provision({
        scopeId: param(req.params, "scopeId"),
        value: body.value,
        ...(body.displayName !== undefined
          ? { displayName: body.displayName }
          : {}),
        actor: "api",
      });
      if (!result.success) {
        return v1Error(
          configService,
          "VALIDATION_ERROR",
          result.error?.message ?? "Provision failed",
        );
      }
      return v1Response(configService, 201, result);
    },
  };
}

function scopeDeprovisionRoute(deps: RouteFactoryDeps): RestRoute {
  const { configService, scopeManager } = deps;
  return {
    method: "DELETE",
    path: "/v1/admin/scopes/:scopeId/:value",
    async handler(req) {
      if (!scopeManager) return missingScopeManager(configService);
      const denied = scopeWriteDenied(deps, req);
      if (denied) return denied;
      const result = await scopeManager.deprovision({
        scopeId: param(req.params, "scopeId"),
        value: param(req.params, "value"),
        actor: "api",
      });
      if (!result.success) {
        return v1Error(
          configService,
          "SCOPE_NOT_FOUND",
          result.error?.message ?? "Scope not found",
        );
      }
      return v1Response(configService, 200, result);
    },
  };
}

function requestKey(req: RestRequest): string {
  return buildPath(param(req.params, "keyPath").split("/"));
}

function requestWriteContext(req: RestRequest): WriteContext {
  const expectedRevision = extractExpectedRevision(req);
  const environment = queryOpt(req.query, "env");
  return {
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(environment ? { environment } : {}),
  };
}

function readDenied(
  authGate: AuthGate | undefined,
  req: RestRequest,
  key: string,
): RestResponse | null {
  if (!authGate || !req.authContext) return null;
  return authGate.gateRead(
    authGate.toAccessContext(req.authContext),
    key,
    req.schemaMap?.get(key),
  );
}

function writeDenied(
  authGate: AuthGate | undefined,
  req: RestRequest,
  layer: string,
  key: string,
): RestResponse | null {
  if (!authGate || !req.authContext) return null;
  return authGate.gateWrite(
    authGate.toAccessContext(req.authContext),
    layer,
    key,
    req.schemaMap?.get(key),
  );
}

function scopeWriteDenied(
  deps: RouteFactoryDeps,
  req: RestRequest,
): RestResponse | null {
  if (!deps.authGate || !req.authContext) return null;
  return deps.authGate.gateWrite(
    deps.authGate.toAccessContext(req.authContext),
    "admin",
    `scopes.${param(req.params, "scopeId")}`,
    undefined,
  );
}

function missingScopeManager(configService: WeaverConfigService): RestResponse {
  return v1Error(
    configService,
    "VALIDATION_ERROR",
    "Scope manager not configured",
  );
}
