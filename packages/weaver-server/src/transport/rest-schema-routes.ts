import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchResponseSchema,
  schemaRegistrationResponseSchema,
} from "@weaver-conf/config-types";
import type { AuditService } from "../audit/audit-service";
import type {
  EffectiveValidationContext,
  WeaverConfigService,
  WriteContext,
} from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
import { parseScopeQuery } from "../core/scope-utils";
import { createWeaverError } from "../types/index";
import type { AuthGate } from "./auth-gate";
import type { RestRequest, RestResponse, RestRoute } from "./rest-adapter";
import {
  extractExpectedRevision,
  registeredSchemasResponse,
  registrationFailure,
  unavailable,
  v1Error,
  v1Response,
  writeFailureResponse,
} from "./rest-route-boundary";
import {
  fragmentSchemaRegistrationBodySchema,
  parseAdminQuery,
  parseRegisteredEffectiveMetadata,
  parseRegisteredEffectiveRequest,
  parseRegisteredObjectRequest,
  parseRegisteredPathRequest,
  parseRegisteredWriteMetadata,
  serviceSchemaRegistrationBodySchema,
} from "./rest-schemas";
import {
  effectiveValidationAuditOutcome,
  restSchemaAuditIdentity,
  schemaRegistrationAuditContext,
  schemaRegistrationAuditOutcome,
  schemaRegistrationPersistenceContext,
  schemaWriteAuditContext,
  schemaWriteAuditOutcome,
} from "./schema-operation-audit";
import { runRestSchemaOperation } from "./schema-operation-runner";

export interface SchemaRouteDeps {
  configService: WeaverConfigService;
  schemaRegistry?: SchemaRegistry | undefined;
  authGate?: AuthGate | undefined;
  auditService?: AuditService | undefined;
  defaultEnvironment: string;
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

function writeContext(request: {
  environment?: string | undefined;
  ifRevision?: string | undefined;
}): WriteContext {
  return {
    ...(request.ifRevision ? { expectedRevision: request.ifRevision } : {}),
    ...(request.environment ? { environment: request.environment } : {}),
  };
}

const schemaRegistryAdminKey = "_weaver.registry.schemas";

function adminDenied(
  request: RestRequest,
  deps: SchemaRouteDeps,
  operation: "read" | "write",
): RestResponse | null {
  const gate = deps.authGate;
  if (!gate) return null;
  if (!request.authContext) return authContextRequired(deps.configService);
  if (!request.authContext.isAdmin) {
    return v1Error(deps.configService, "FORBIDDEN", "Admin access required");
  }
  const context = gate.toAccessContext(request.authContext);
  if (operation === "read") {
    return gate.gateRead(context, schemaRegistryAdminKey);
  }
  return gate.gateWrite(context, "admin", schemaRegistryAdminKey);
}

function registeredWriteDenied(
  request: RestRequest,
  deps: SchemaRouteDeps,
  metadata: { readonly layer: string; readonly path: string },
): RestResponse | null {
  const gate = deps.authGate;
  if (!gate) return null;
  if (!request.authContext) return authContextRequired(deps.configService);
  const key = parseCanonicalConfigPath(metadata.path).storageKey;
  return gate.gateWrite(
    gate.toAccessContext(request.authContext),
    metadata.layer,
    key,
    request.schemaMap?.get(key),
  );
}

async function registeredReadDenied(
  request: RestRequest,
  deps: SchemaRouteDeps,
  metadata: {
    readonly anchorPath: string;
    readonly environment?: string | undefined;
  },
): Promise<RestResponse | null> {
  const gate = deps.authGate;
  if (!gate) return null;
  if (!request.authContext) return authContextRequired(deps.configService);
  const registry = deps.schemaRegistry;
  if (!registry) return inaccessibleAnchor(request, deps);
  const anchor = await registry.resolveAnchor(
    metadata.anchorPath,
    metadata.environment,
  );
  if (!anchor || anchor.path !== metadata.anchorPath) {
    return inaccessibleAnchor(request, deps);
  }
  const key = parseCanonicalConfigPath(metadata.anchorPath).storageKey;
  return gate.gateRead(
    gate.toAccessContext(request.authContext),
    key,
    anchor.schema,
  );
}

function inaccessibleAnchor(
  request: RestRequest,
  deps: SchemaRouteDeps,
): RestResponse | null {
  if (request.authContext?.isAdmin) return null;
  return v1Error(
    deps.configService,
    "FORBIDDEN",
    "Registered schema is not accessible",
  );
}

function authContextRequired(configService: WeaverConfigService): RestResponse {
  return v1Error(configService, "UNAUTHORIZED", "Authentication required");
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
      const denied = adminDenied(req, deps, "read");
      if (denied) return denied;
      parseAdminQuery(req.query);
      if (!schemaRegistry) return unavailable(configService);
      return registeredSchemasResponse(configService, schemaRegistry.listAll());
    },
  };
}

function registerServiceRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "POST",
    path: "/v1/admin/schemas/services",
    async handler(req) {
      const denied = adminDenied(req, deps, "write");
      if (denied) return denied;
      parseAdminQuery(req.query);
      if (!schemaRegistry) return unavailable(configService);
      const body = serviceSchemaRegistrationBodySchema.parse(req.body);
      const identity = restSchemaAuditIdentity(req.authContext);
      const result = await runRestSchemaOperation(
        deps.auditService,
        schemaRegistrationAuditContext(body, identity),
        () =>
          schemaRegistry.register(
            body,
            schemaRegistrationPersistenceContext(identity),
          ),
        "service schema registration",
        schemaRegistrationResponseSchema,
        schemaRegistrationAuditOutcome,
      );
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
      const denied = adminDenied(req, deps, "write");
      if (denied) return denied;
      parseAdminQuery(req.query);
      if (!schemaRegistry) return unavailable(configService);
      const body = fragmentSchemaRegistrationBodySchema.parse(req.body);
      const identity = restSchemaAuditIdentity(req.authContext);
      const result = await runRestSchemaOperation(
        deps.auditService,
        schemaRegistrationAuditContext(body, identity),
        () =>
          schemaRegistry.register(
            body,
            schemaRegistrationPersistenceContext(identity),
          ),
        "fragment schema registration",
        schemaRegistrationResponseSchema,
        schemaRegistrationAuditOutcome,
      );
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
      const metadata = parseRegisteredWriteMetadata(
        canonicalRoutePath(req.params, "anchorPath"),
        req.query,
        extractExpectedRevision(req, { strictQuotes: true }),
      );
      const denied = registeredWriteDenied(req, deps, metadata);
      if (denied) return denied;
      if (!schemaRegistry) return unavailable(configService);
      const request = parseRegisteredObjectRequest(metadata, req.body);
      const result = await runRestSchemaOperation(
        deps.auditService,
        schemaWriteAuditContext(
          "schema.write.object",
          request.anchorPath,
          request.environment ?? deps.defaultEnvironment,
          restSchemaAuditIdentity(req.authContext),
        ),
        () =>
          configService.setRegisteredObject(
            request.layer ?? "platform",
            request.anchorPath,
            request.value,
            { ...writeContext(request), schemaRegistry },
          ),
        "registered object write",
        registeredObjectWriteResponseSchema,
        (response) =>
          schemaWriteAuditOutcome(response, "Registered object write failed"),
      );
      if (!result.success) {
        return writeFailureResponse(
          configService,
          result,
          "Registered object write failed",
          { includeDetails: true },
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
      const metadata = parseRegisteredWriteMetadata(
        canonicalRoutePath(req.params, "path"),
        req.query,
        extractExpectedRevision(req, { strictQuotes: true }),
      );
      const denied = registeredWriteDenied(req, deps, metadata);
      if (denied) return denied;
      if (!schemaRegistry) return unavailable(configService);
      const request = parseRegisteredPathRequest(metadata, req.body);
      const result = await runRestSchemaOperation(
        deps.auditService,
        schemaWriteAuditContext(
          "schema.patch.path",
          request.path,
          request.environment ?? deps.defaultEnvironment,
          restSchemaAuditIdentity(req.authContext),
        ),
        () =>
          configService.patchRegisteredPath(
            request.layer ?? "platform",
            request.path,
            request.value,
            { ...writeContext(request), schemaRegistry },
          ),
        "registered path patch",
        registeredPathPatchResponseSchema,
        (response) =>
          schemaWriteAuditOutcome(response, "Registered path patch failed"),
      );
      if (!result.success) {
        return writeFailureResponse(
          configService,
          result,
          "Registered path patch failed",
          { includeDetails: true },
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
      const metadata = parseRegisteredEffectiveMetadata(
        canonicalRoutePath(req.params, "anchorPath"),
        req.query,
      );
      const denied = await registeredReadDenied(req, deps, metadata);
      if (denied) return denied;
      if (!schemaRegistry) {
        return { ...unavailable(configService), status: 422 };
      }
      const request = parseRegisteredEffectiveRequest(metadata);
      const validation = await runRestSchemaOperation(
        deps.auditService,
        schemaWriteAuditContext(
          "schema.validate.effective",
          request.anchorPath,
          request.environment ?? deps.defaultEnvironment,
          restSchemaAuditIdentity(req.authContext),
        ),
        () =>
          configService.validateRegisteredEffective(
            request.anchorPath,
            effectiveValidationContext(request, schemaRegistry),
          ),
        "registered effective validation",
        registeredEffectiveValidationResponseSchema,
        effectiveValidationAuditOutcome,
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
  request: {
    environment?: string | undefined;
    scope?: string | undefined;
  },
  schemaRegistry: SchemaRegistry,
): EffectiveValidationContext {
  const scopePath = request.scope ? parseScopeQuery(request.scope) : undefined;
  return {
    schemaRegistry,
    ...(request.environment ? { environment: request.environment } : {}),
    ...(scopePath ? { scopePath } : {}),
  };
}
