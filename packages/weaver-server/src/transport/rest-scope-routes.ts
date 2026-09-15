import { createWeaverError } from "@weaver-conf/config-types";
import { parseScopeQuery } from "../core/scope-utils";
import type { RestRequest, RestResponse, RestRoute } from "./rest-adapter";
import {
  extractExpectedRevision,
  param,
  v1Error,
  v1Response,
} from "./rest-helpers";
import type { RouteFactoryDeps } from "./rest-routes";
import { scopeProvisionBodySchema } from "./rest-schemas";
import { gateScopeAdministration } from "./rest-scope-auth";

export function buildScopeRoutes(deps: RouteFactoryDeps): RestRoute[] {
  const { configService, scopeManager } = deps;
  return [
    {
      method: "GET",
      path: "/v1/scopes",
      async handler() {
        return v1Response(configService, 200, {
          definitions: scopeManager?.listScopes() ?? [],
        });
      },
    },
    {
      method: "GET",
      path: "/v1/scopes/:scopeId",
      async handler(req) {
        const values =
          scopeManager?.listScopeValues(param(req.params, "scopeId")) ?? [];
        return v1Response(configService, 200, { values });
      },
    },
    {
      method: "POST",
      path: "/v1/admin/scopes/:scopeId",
      handler: (req) => provision(req, deps),
    },
    {
      method: "DELETE",
      path: "/v1/admin/scopes/:scopeId/:value",
      handler: (req) => deprovision(req, deps),
    },
  ];
}

function gateLifecycle(
  req: RestRequest,
  deps: RouteFactoryDeps,
): RestResponse | null {
  const denied = gateScopeAdministration(req, deps);
  if (denied) return denied;
  if (!deps.scopeManager)
    return v1Error(
      deps.configService,
      "VALIDATION_ERROR",
      "Scope manager not configured",
    );
  if (!deps.authGate || !req.authContext) return null;
  return deps.authGate.gateWrite(
    deps.authGate.toAccessContext(req.authContext),
    "admin",
    `scopes.${param(req.params, "scopeId")}`,
    undefined,
  );
}

async function provision(
  req: RestRequest,
  deps: RouteFactoryDeps,
): Promise<RestResponse> {
  const denied = gateLifecycle(req, deps);
  if (denied) return denied;
  const { configService, scopeManager } = deps;
  if (!scopeManager)
    return v1Error(
      configService,
      "VALIDATION_ERROR",
      "Scope manager not configured",
    );
  const body = scopeProvisionBodySchema.parse(req.body);
  const expectedRevision = extractExpectedRevision(req);
  const result = await scopeManager.provision({
    ...lifecycleTarget(req, body.value),
    ...(body.displayName !== undefined
      ? { displayName: body.displayName }
      : {}),
    actor: "api",
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  return result.success
    ? v1Response(configService, 201, result)
    : v1Error(
        configService,
        result.error?.code ?? "VALIDATION_ERROR",
        result.error?.message ?? "Provision failed",
      );
}

async function deprovision(
  req: RestRequest,
  deps: RouteFactoryDeps,
): Promise<RestResponse> {
  const denied = gateLifecycle(req, deps);
  if (denied) return denied;
  const { configService, scopeManager } = deps;
  if (!scopeManager)
    return v1Error(
      configService,
      "VALIDATION_ERROR",
      "Scope manager not configured",
    );
  const expectedRevision = extractExpectedRevision(req);
  const result = await scopeManager.deprovision({
    ...lifecycleTarget(req, param(req.params, "value")),
    actor: "api",
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  return result.success
    ? v1Response(configService, 200, result)
    : v1Error(
        configService,
        result.error?.code ?? "SCOPE_NOT_FOUND",
        result.error?.message ?? "Scope not found",
      );
}

function lifecycleTarget(req: RestRequest, value: string) {
  const scopeId = param(req.params, "scopeId");
  const scopePath = parseScopeQuery(req.query.scope);
  if (!scopePath) return { scopeId, value };
  const target = scopePath.at(-1);
  if (target?.scopeId !== scopeId || target.value !== value)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Route target does not match its full scope path",
    );
  return { scopePath };
}
