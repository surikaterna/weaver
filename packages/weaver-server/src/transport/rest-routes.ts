import { buildPath } from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";
import type { AuditService } from "../audit/audit-service";
import type { WeaverConfigService, WriteContext } from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { assertServiceScope, parseScopeQuery } from "../core/scope-utils";
import type { WeaverRuntime } from "../server-runtime";
import type { AuthGate } from "./auth-gate";
import type { RestRequest, RestResponse, RestRoute } from "./rest-adapter";
import {
  extractExpectedRevision,
  param,
  queryOpt,
  v1Error,
  v1Response,
} from "./rest-helpers";
import { buildSchemaRoutes } from "./rest-schema-routes";
import { configBatchBodySchema, configWriteBodySchema } from "./rest-schemas";
import { buildScopeRoutes } from "./rest-scope-routes";
import { buildUpgradeRoutes } from "./rest-upgrade-routes";

export interface RouteFactoryDeps {
  configService: WeaverConfigService;
  schemaRegistry?: SchemaRegistry | undefined;
  scopeManager?: ScopeManager | undefined;
  authGate?: AuthGate | undefined;
  auditService?: AuditService | undefined;
  runtime?: WeaverRuntime | undefined;
}

export function buildRoutes(deps: RouteFactoryDeps): RestRoute[] {
  return [
    ...buildUpgradeRoutes(deps.runtime),
    ...buildSchemaRoutes(deps),
    readAllRoute(deps),
    readKeyRoute(deps),
    setRoute(deps),
    removeRoute(deps),
    batchRoute(deps),
    ...buildScopeRoutes(deps),
  ];
}

function readAllRoute({
  configService,
  authGate,
}: RouteFactoryDeps): RestRoute {
  return {
    method: "GET",
    path: "/v1/config",
    async handler(req) {
      const scopePath = parseScopeQuery(queryOpt(req.query, "scope"));
      await assertServiceScope(configService, scopePath);
      const snapshot = await configService.resolveAll(
        scopePath ? { scopePath } : {},
      );
      if (authGate && req.authContext) {
        const context = authGate.toAccessContext(req.authContext);
        const filter = (entries: Record<string, unknown>) =>
          authGate.filterVisible(context, entries, req.schemaMap ?? new Map());
        return v1Response(configService, 200, {
          ...snapshot,
          entries: filter(snapshot.entries),
          scopes: Object.fromEntries(
            Object.entries(snapshot.scopes).map(([scope, entries]) => [
              scope,
              filter(entries),
            ]),
          ),
        });
      }
      return v1Response(configService, 200, snapshot);
    },
  };
}

function readKeyRoute({
  configService,
  authGate,
}: RouteFactoryDeps): RestRoute {
  return {
    method: "GET",
    path: "/v1/config/*keyPath",
    async handler(req) {
      const key = buildPath(param(req.params, "keyPath").split("/"));
      const scopePath = parseScopeQuery(queryOpt(req.query, "scope"));
      if (authGate && req.authContext) {
        const denied = authGate.gateRead(
          authGate.toAccessContext(req.authContext),
          key,
          req.schemaMap?.get(key),
        );
        if (denied) return denied;
      }
      await assertServiceScope(configService, scopePath);
      if ("inspect" in req.query)
        return v1Response(configService, 200, await configService.inspect(key));
      const value = await configService.get(
        key,
        scopePath ? { scopePath } : {},
      );
      return v1Response(configService, 200, { key, value });
    },
  };
}

function writeContext(req: RestRequest): WriteContext {
  const expectedRevision = extractExpectedRevision(req);
  const environment = queryOpt(req.query, "env");
  return {
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(environment ? { environment } : {}),
  };
}

function gateWrite(
  req: RestRequest,
  deps: RouteFactoryDeps,
  layer: string,
  key: string,
): RestResponse | null {
  const gate = deps.authGate;
  return gate && req.authContext
    ? gate.gateWrite(
        gate.toAccessContext(req.authContext),
        layer,
        key,
        req.schemaMap?.get(key),
      )
    : null;
}

function writeResponse(
  service: WeaverConfigService,
  result: WriteResult,
  fallback: string,
): RestResponse {
  if (result.success) return v1Response(service, 200, result);
  return v1Error(
    service,
    result.error?.code === "REVISION_CONFLICT" ||
      result.error?.code === "MAINTENANCE" ||
      result.error?.code === "SERVER_DEGRADED" ||
      result.error?.code === "CONFIG_NOT_READY"
      ? result.error.code
      : "VALIDATION_ERROR",
    result.error?.message ?? fallback,
  );
}

function setRoute(deps: RouteFactoryDeps): RestRoute {
  return {
    method: "PUT",
    path: "/v1/config/*keyPath",
    async handler(req) {
      const key = buildPath(param(req.params, "keyPath").split("/"));
      const layer = queryOpt(req.query, "layer") ?? "platform";
      const denied = gateWrite(req, deps, layer, key);
      if (denied) return denied;
      const body = configWriteBodySchema.parse(req.body);
      const result = await deps.configService.set(
        layer,
        key,
        body.value,
        writeContext(req),
      );
      return writeResponse(deps.configService, result, "Write failed");
    },
  };
}

function removeRoute(deps: RouteFactoryDeps): RestRoute {
  return {
    method: "DELETE",
    path: "/v1/config/*keyPath",
    async handler(req) {
      const key = buildPath(param(req.params, "keyPath").split("/"));
      const layer = queryOpt(req.query, "layer") ?? "platform";
      const denied = gateWrite(req, deps, layer, key);
      if (denied) return denied;
      const result = await deps.configService.remove(
        layer,
        key,
        writeContext(req),
      );
      return writeResponse(deps.configService, result, "Remove failed");
    },
  };
}

function batchRoute(deps: RouteFactoryDeps): RestRoute {
  return {
    method: "PATCH",
    path: "/v1/config",
    async handler(req) {
      const layer = queryOpt(req.query, "layer") ?? "platform";
      const { entries } = configBatchBodySchema.parse(req.body);
      for (const key of Object.keys(entries)) {
        const denied = gateWrite(req, deps, layer, key);
        if (denied) return denied;
      }
      const result = await deps.configService.setMany(
        layer,
        entries,
        writeContext(req),
      );
      if (!result.success)
        return writeResponse(deps.configService, result, "Batch write failed");
      return v1Response(deps.configService, 200, {
        ...result,
        written: Object.keys(entries).length,
      });
    },
  };
}
