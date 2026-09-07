import { buildPath } from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";
import type { AuditService } from "../audit/audit-service";
import type {
  EffectiveValidationContext,
  WeaverConfigService,
  WriteContext,
} from "../core/config-service";
import type { SchemaOperationContext } from "../core/schema-operation-context";
import type {
  SchemaRegistrationResult,
  SchemaRegistry,
} from "../core/schema-registry";
import { parseScopeQuery } from "../core/scope-utils";
import type { WeaverErrorCode } from "../types/index";
import { createWeaverError, httpStatusForError } from "../types/index";
import type { AuthGate } from "./auth-gate";
import type { RestRequest, RestResponse, RestRoute } from "./rest-adapter";
import { envelope, errorEnvelope, v1Headers } from "./rest-helpers";
import {
  fragmentSchemaRegistrationBodySchema,
  registeredEffectiveValidationQuerySchema,
  registeredObjectWriteBodySchema,
  registeredPathPatchBodySchema,
  serviceSchemaRegistrationBodySchema,
} from "./rest-schemas";
import {
  auditSchemaRegistration,
  auditSchemaWrite,
  effectiveValidationRouteContext,
  recordSchemaAuditEvent,
  registeredObjectWriteRouteContext,
  registeredPathPatchRouteContext,
  schemaRegistrationRequestContext,
  schemaRegistrationRouteContext,
} from "./schema-route-audit";

export interface SchemaRouteDeps {
  configService: WeaverConfigService;
  schemaRegistry?: SchemaRegistry | undefined;
  authGate?: AuthGate | undefined;
  auditService?: AuditService | undefined;
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
  details?: Record<string, unknown>,
): RestResponse {
  const rev = configService.revision;
  const err = createWeaverError(code, message, details);
  return {
    status: httpStatusForError(code),
    body: errorEnvelope(err, rev),
    headers: v1Headers(rev),
  };
}

function unavailable(configService: WeaverConfigService): RestResponse {
  return v1Error(
    configService,
    "VALIDATION_ERROR",
    "Schema registry not configured",
  );
}

function canonicalRoutePath(
  params: Record<string, string>,
  name: string,
): string {
  const value = params[name];
  if (!value) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Missing required route parameter: ${name}`,
    );
  }
  return `/${value}`;
}

function extractExpectedRevision(req: RestRequest): string | undefined {
  const ifMatch = req.headers["if-match"];
  if (ifMatch === undefined) return undefined;
  return ifMatch.replace(/^"|"$/g, "");
}

const schemaRegistryAdminKey = "_weaver.registry.schemas";

function storageKeyFromCanonicalPath(path: string): string {
  return buildPath(path.slice(1).split("/"));
}

function gateRead(
  req: RestRequest,
  deps: SchemaRouteDeps,
  key: string,
): RestResponse | null {
  if (!deps.authGate) return null;
  if (!req.authContext) return authContextRequired(deps.configService);
  const accessCtx = deps.authGate.toAccessContext(req.authContext);
  return deps.authGate.gateRead(accessCtx, key, req.schemaMap?.get(key));
}

function gateAdminRead(
  req: RestRequest,
  deps: SchemaRouteDeps,
): RestResponse | null {
  if (!deps.authGate) return null;
  if (!req.authContext) return authContextRequired(deps.configService);
  if (!req.authContext.isAdmin) {
    return v1Error(deps.configService, "FORBIDDEN", "Admin access required");
  }
  return null;
}

function gateWrite(
  req: RestRequest,
  deps: SchemaRouteDeps,
  layer: string,
  key: string,
): RestResponse | null {
  if (!deps.authGate) return null;
  if (!req.authContext) return authContextRequired(deps.configService);
  const accessCtx = deps.authGate.toAccessContext(req.authContext);
  return deps.authGate.gateWrite(
    accessCtx,
    layer,
    key,
    req.schemaMap?.get(key),
  );
}

function authContextRequired(configService: WeaverConfigService): RestResponse {
  return v1Error(configService, "UNAUTHORIZED", "Authentication required");
}

function writeContext(
  req: RestRequest,
  schemaOperation?: SchemaOperationContext | undefined,
): WriteContext {
  const expectedRevision = extractExpectedRevision(req);
  const environment = req.query.env;
  return {
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(environment ? { environment } : {}),
    ...(schemaOperation ? { schemaOperation } : {}),
  };
}

function writeFailureResponse(
  configService: WeaverConfigService,
  fallback: string,
  result: WriteResult,
): RestResponse {
  const error = result.error;
  const code: WeaverErrorCode =
    error?.code === "REVISION_CONFLICT"
      ? "REVISION_CONFLICT"
      : "VALIDATION_ERROR";
  const status = code === "REVISION_CONFLICT" ? 409 : httpStatusForError(code);
  const rev = configService.revision;
  const details = isRecord(error?.details) ? error.details : undefined;
  return {
    status,
    body: errorEnvelope(
      createWeaverError(code, error?.message ?? fallback, details),
      rev,
    ),
    headers: v1Headers(rev),
  };
}

export function buildSchemaRoutes(deps: SchemaRouteDeps): RestRoute[] {
  return [
    listSchemasRoute(deps),
    registerServiceRoute(deps),
    registerFragmentRoute(deps),
    setRegisteredObjectRoute(deps),
    patchRegisteredPathRoute(deps),
    validateRegisteredEffectiveRoute(deps),
  ];
}

function listSchemasRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "GET",
    path: "/v1/admin/schemas",
    async handler(req) {
      const adminDenied = gateAdminRead(req, deps);
      if (adminDenied) return adminDenied;
      if (!schemaRegistry) return unavailable(configService);
      const denied = gateRead(req, deps, schemaRegistryAdminKey);
      if (denied) return denied;
      return v1Response(configService, 200, {
        schemas: schemaRegistry.listAll(),
      });
    },
  };
}

function registerServiceRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "POST",
    path: "/v1/admin/schemas/services",
    async handler(req) {
      if (!schemaRegistry) return unavailable(configService);
      const denied = gateWrite(req, deps, "admin", schemaRegistryAdminKey);
      if (denied) return denied;
      const body = serviceSchemaRegistrationBodySchema.parse(req.body);
      const operation = schemaRegistrationRouteContext(req, body);
      const result = await schemaRegistry.register(
        body,
        schemaRegistrationRequestContext(req, operation),
      );
      await auditSchemaRegistration(deps.auditService, operation, result);
      if (!result.success) return registrationFailure(configService, result);
      return v1Response(configService, 201, result);
    },
  };
}

function registerFragmentRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "POST",
    path: "/v1/admin/schemas/fragments",
    async handler(req) {
      if (!schemaRegistry) return unavailable(configService);
      const denied = gateWrite(req, deps, "admin", schemaRegistryAdminKey);
      if (denied) return denied;
      const body = fragmentSchemaRegistrationBodySchema.parse(req.body);
      const operation = schemaRegistrationRouteContext(req, body);
      const result = await schemaRegistry.register(
        body,
        schemaRegistrationRequestContext(req, operation),
      );
      await auditSchemaRegistration(deps.auditService, operation, result);
      if (!result.success) return registrationFailure(configService, result);
      return v1Response(configService, 201, result);
    },
  };
}

function setRegisteredObjectRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "PUT",
    path: "/v1/registered/objects/*anchorPath",
    async handler(req) {
      if (!schemaRegistry) return unavailable(configService);
      const layer = req.query.layer ?? "platform";
      const anchorPath = canonicalRoutePath(req.params, "anchorPath");
      const key = storageKeyFromCanonicalPath(anchorPath);
      const denied = gateWrite(req, deps, layer, key);
      if (denied) return denied;
      const body = registeredObjectWriteBodySchema.parse(req.body);
      const operation = registeredObjectWriteRouteContext(req, anchorPath);
      const result = await configService.setRegisteredObject(
        layer,
        anchorPath,
        body.value,
        { ...writeContext(req, operation), schemaRegistry },
      );
      await auditSchemaWrite(
        deps.auditService,
        operation,
        result,
        "Registered object write failed",
      );
      if (!result.success) {
        return writeFailureResponse(
          configService,
          "Registered object write failed",
          result,
        );
      }
      return v1Response(configService, 200, result);
    },
  };
}

function patchRegisteredPathRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "PATCH",
    path: "/v1/registered/paths/*path",
    async handler(req) {
      if (!schemaRegistry) return unavailable(configService);
      const layer = req.query.layer ?? "platform";
      const path = canonicalRoutePath(req.params, "path");
      const key = storageKeyFromCanonicalPath(path);
      const denied = gateWrite(req, deps, layer, key);
      if (denied) return denied;
      const body = registeredPathPatchBodySchema.parse(req.body);
      const operation = registeredPathPatchRouteContext(req, path);
      const result = await configService.patchRegisteredPath(
        layer,
        path,
        body.value,
        { ...writeContext(req, operation), schemaRegistry },
      );
      await auditSchemaWrite(
        deps.auditService,
        operation,
        result,
        "Registered path patch failed",
      );
      if (!result.success) {
        return writeFailureResponse(
          configService,
          "Registered path patch failed",
          result,
        );
      }
      return v1Response(configService, 200, result);
    },
  };
}

function validateRegisteredEffectiveRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "GET",
    path: "/v1/registered/effective/*anchorPath",
    async handler(req) {
      if (!schemaRegistry) return unavailable(configService);
      const anchorPath = canonicalRoutePath(req.params, "anchorPath");
      const key = storageKeyFromCanonicalPath(anchorPath);
      const denied = gateRead(req, deps, key);
      if (denied) return denied;
      const context = effectiveValidationContext(req, schemaRegistry);
      const operation = effectiveValidationRouteContext(
        req,
        anchorPath,
        context.environment,
      );
      const validation = await configService.validateRegisteredEffective(
        anchorPath,
        { ...context, schemaOperation: operation },
      );
      await recordSchemaAuditEvent(
        deps.auditService,
        operation,
        validation.valid,
        validation.valid ? undefined : "Registered effective validation failed",
      );
      return v1Response(
        configService,
        validation.valid ? 200 : 422,
        validation,
      );
    },
  };
}

function effectiveValidationContext(
  req: RestRequest,
  schemaRegistry: SchemaRegistry,
): EffectiveValidationContext {
  const query = registeredEffectiveValidationQuerySchema.parse(req.query);
  const scopePath = query.scope ? parseScopeQuery(query.scope) : undefined;
  return {
    schemaRegistry,
    ...(query.environment ? { environment: query.environment } : {}),
    ...(scopePath ? { scopePath } : {}),
  };
}

function registrationFailure(
  configService: WeaverConfigService,
  result: SchemaRegistrationResult,
): RestResponse {
  return v1Error(
    configService,
    "VALIDATION_ERROR",
    result.error?.message ?? "Schema registration failed",
    result.error?.details,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
