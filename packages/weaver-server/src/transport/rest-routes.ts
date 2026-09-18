// REST route definitions for config and scope endpoints

import { buildPath } from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";
import type { WeaverConfigService, WriteContext } from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { parseScopeQuery } from "../core/scope-utils";
import type { WeaverErrorCode } from "../types/index";
import { createWeaverError, httpStatusForError } from "../types/index";
import type { AuthGate } from "./auth-gate";
import type { RestRequest, RestResponse, RestRoute } from "./rest-adapter";
import { envelope, errorEnvelope, v1Headers } from "./rest-helpers";
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

function v1Response<T>(
  configService: WeaverConfigService,
  status: number,
  data: T,
): RestResponse {
  const rev = configService.revision;
  return { status, body: envelope(data, rev), headers: v1Headers(rev) };
}

function v1Error(
  configService: WeaverConfigService,
  code: WeaverErrorCode,
  message: string,
): RestResponse {
  const rev = configService.revision;
  const err = createWeaverError(code, message);
  return {
    status: httpStatusForError(code),
    body: errorEnvelope(err, rev),
    headers: v1Headers(rev),
  };
}

function extractExpectedRevision(req: RestRequest): string | undefined {
  const ifMatch = req.headers["if-match"];
  if (ifMatch === undefined) return undefined;
  return ifMatch.replace(/^"|"$/g, "");
}

function writeErrorResponse(
  configService: WeaverConfigService,
  result: WriteResult,
  fallback: string,
): RestResponse {
  const errorObj = result.error;
  const msg = errorObj?.message ?? fallback;
  const code: WeaverErrorCode =
    errorObj?.code === "REVISION_CONFLICT"
      ? "REVISION_CONFLICT"
      : "VALIDATION_ERROR";
  const status = code === "REVISION_CONFLICT" ? 409 : httpStatusForError(code);
  const rev = configService.revision;
  return {
    status,
    body: errorEnvelope(createWeaverError(code, msg), rev),
    headers: v1Headers(rev),
  };
}

export function buildRoutes(deps: RouteFactoryDeps): RestRoute[] {
  const { configService, schemaRegistry, scopeManager, authGate } = deps;

  return [
    ...buildSchemaRoutes({ configService, schemaRegistry, authGate }),
    {
      method: "GET",
      path: "/v1/config",
      async handler(req) {
        const scopePath = parseScopeQuery(queryOpt(req.query, "scope"));
        const opts = scopePath ? { scopePath } : {};
        const snapshot = await configService.resolveAll(opts);
        if (authGate && req.authContext) {
          const accessCtx = authGate.toAccessContext(req.authContext);
          const filtered = authGate.filterVisible(
            accessCtx,
            snapshot,
            req.schemaMap ?? new Map(),
          );
          return v1Response(configService, 200, filtered);
        }
        return v1Response(configService, 200, snapshot);
      },
    },
    {
      method: "GET",
      path: "/v1/config/*keyPath",
      async handler(req) {
        const keyPath = param(req.params, "keyPath");
        const segments = keyPath.split("/");
        const key = buildPath(segments);
        const scopePath = parseScopeQuery(queryOpt(req.query, "scope"));
        const opts = scopePath ? { scopePath } : {};
        if (authGate && req.authContext) {
          const accessCtx = authGate.toAccessContext(req.authContext);
          const denied = authGate.gateRead(
            accessCtx,
            key,
            req.schemaMap?.get(key),
          );
          if (denied) return denied;
        }
        if ("inspect" in req.query) {
          const inspection = await configService.inspect(key);
          return v1Response(configService, 200, inspection);
        }
        const value = await configService.get(key, opts);
        return v1Response(configService, 200, { key, value });
      },
    },
    {
      method: "PUT",
      path: "/v1/config/*keyPath",
      async handler(req) {
        const keyPath = param(req.params, "keyPath");
        const segments = keyPath.split("/");
        const key = buildPath(segments);
        const layer = queryOpt(req.query, "layer") ?? "platform";
        const environment = queryOpt(req.query, "env");
        if (authGate && req.authContext) {
          const accessCtx = authGate.toAccessContext(req.authContext);
          const denied = authGate.gateWrite(
            accessCtx,
            layer,
            key,
            req.schemaMap?.get(key),
          );
          if (denied) return denied;
        }
        const body = configWriteBodySchema.parse(req.body);
        const expectedRevision = extractExpectedRevision(req);
        const writeCtx: WriteContext = {};
        if (expectedRevision) writeCtx.expectedRevision = expectedRevision;
        if (environment) writeCtx.environment = environment;
        const result = await configService.set(
          layer,
          key,
          body.value,
          writeCtx,
        );
        if (!result.success)
          return writeErrorResponse(configService, result, "Write failed");
        return v1Response(configService, 200, result);
      },
    },
    {
      method: "DELETE",
      path: "/v1/config/*keyPath",
      async handler(req) {
        const keyPath = param(req.params, "keyPath");
        const segments = keyPath.split("/");
        const key = buildPath(segments);
        const layer = queryOpt(req.query, "layer") ?? "platform";
        const environment = queryOpt(req.query, "env");
        if (authGate && req.authContext) {
          const accessCtx = authGate.toAccessContext(req.authContext);
          const denied = authGate.gateWrite(
            accessCtx,
            layer,
            key,
            req.schemaMap?.get(key),
          );
          if (denied) return denied;
        }
        const expectedRevision = extractExpectedRevision(req);
        const writeCtx: WriteContext = {};
        if (expectedRevision) writeCtx.expectedRevision = expectedRevision;
        if (environment) writeCtx.environment = environment;
        const result = await configService.remove(layer, key, writeCtx);
        if (!result.success)
          return writeErrorResponse(configService, result, "Remove failed");
        return v1Response(configService, 200, result);
      },
    },
    {
      method: "PATCH",
      path: "/v1/config",
      async handler(req) {
        const layer = queryOpt(req.query, "layer") ?? "platform";
        const environment = queryOpt(req.query, "env");
        const body = configBatchBodySchema.parse(req.body);
        const entries = body.entries;
        if (authGate && req.authContext) {
          const accessCtx = authGate.toAccessContext(req.authContext);
          for (const key of Object.keys(entries)) {
            const denied = authGate.gateWrite(
              accessCtx,
              layer,
              key,
              req.schemaMap?.get(key),
            );
            if (denied) return denied;
          }
        }
        const expectedRevision = extractExpectedRevision(req);
        const writeCtx: WriteContext = {};
        if (expectedRevision) writeCtx.expectedRevision = expectedRevision;
        if (environment) writeCtx.environment = environment;
        const result = await configService.setMany(layer, entries, writeCtx);
        if (!result.success)
          return writeErrorResponse(
            configService,
            result,
            "Batch write failed",
          );
        return v1Response(configService, 200, {
          ...result,
          written: Object.keys(entries).length,
        });
      },
    },
    {
      method: "GET",
      path: "/v1/scopes",
      async handler() {
        if (!scopeManager) {
          return v1Response(configService, 200, { definitions: [] });
        }
        const definitions = scopeManager.listScopes();
        return v1Response(configService, 200, { definitions });
      },
    },
    {
      method: "GET",
      path: "/v1/scopes/:scopeId",
      async handler(req) {
        if (!scopeManager) {
          return v1Response(configService, 200, { values: [] });
        }
        const scopeId = param(req.params, "scopeId");
        const values = scopeManager.listScopeValues(scopeId);
        return v1Response(configService, 200, { values });
      },
    },
    {
      method: "POST",
      path: "/v1/admin/scopes/:scopeId",
      async handler(req) {
        if (!scopeManager) {
          return v1Error(
            configService,
            "VALIDATION_ERROR",
            "Scope manager not configured",
          );
        }
        if (authGate && req.authContext) {
          const accessCtx = authGate.toAccessContext(req.authContext);
          const denied = authGate.gateWrite(
            accessCtx,
            "admin",
            `scopes.${param(req.params, "scopeId")}`,
            undefined,
          );
          if (denied) return denied;
        }
        const scopeId = param(req.params, "scopeId");
        const body = scopeProvisionBodySchema.parse(req.body);
        const value = body.value;
        const displayName = body.displayName;
        const result = await scopeManager.provision({
          scopeId,
          value,
          ...(displayName !== undefined ? { displayName } : {}),
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
    },
    {
      method: "DELETE",
      path: "/v1/admin/scopes/:scopeId/:value",
      async handler(req) {
        if (!scopeManager) {
          return v1Error(
            configService,
            "VALIDATION_ERROR",
            "Scope manager not configured",
          );
        }
        if (authGate && req.authContext) {
          const accessCtx = authGate.toAccessContext(req.authContext);
          const denied = authGate.gateWrite(
            accessCtx,
            "admin",
            `scopes.${param(req.params, "scopeId")}`,
            undefined,
          );
          if (denied) return denied;
        }
        const scopeId = param(req.params, "scopeId");
        const value = param(req.params, "value");
        const result = await scopeManager.deprovision({
          scopeId,
          value,
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
    },
  ];
}
