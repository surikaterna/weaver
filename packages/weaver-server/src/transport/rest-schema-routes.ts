import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchResponseSchema,
  registeredSchemasResponseSchema,
  type SchemaRegistrationResponse,
  schemaRegistrationResponseSchema,
} from "@weaver-conf/config-types";
import type { z } from "zod";
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

export interface SchemaRouteDeps {
  configService: WeaverConfigService;
  schemaRegistry?: SchemaRegistry | undefined;
  authGate?: AuthGate | undefined;
}

class RestResponseContractError extends Error {
  constructor(operation: string, cause: z.ZodError) {
    super(`Malformed ${operation} response: ${cause.message}`, { cause });
    this.name = "RestResponseContractError";
  }
}

function parseResponse<T>(
  operation: string,
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RestResponseContractError(operation, result.error);
  }
  return result.data;
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

function registeredReadDenied(
  request: RestRequest,
  deps: SchemaRouteDeps,
  path: string,
): RestResponse | null {
  const gate = deps.authGate;
  if (!gate) return null;
  if (!request.authContext) return authContextRequired(deps.configService);
  const key = parseCanonicalConfigPath(path).storageKey;
  return gate.gateRead(
    gate.toAccessContext(request.authContext),
    key,
    request.schemaMap?.get(key),
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
      const response = parseResponse(
        "registered schemas",
        registeredSchemasResponseSchema,
        { schemas: schemaRegistry.listAll() },
      );
      return v1Response(configService, 200, response);
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
      const result = parseResponse(
        "service schema registration",
        schemaRegistrationResponseSchema,
        await schemaRegistry.register(body, registrationContext(req)),
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
      const result = parseResponse(
        "fragment schema registration",
        schemaRegistrationResponseSchema,
        await schemaRegistry.register(body, registrationContext(req)),
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
      const result = parseResponse(
        "registered object write",
        registeredObjectWriteResponseSchema,
        await configService.setRegisteredObject(
          request.layer ?? "platform",
          request.anchorPath,
          request.value,
          { ...writeContext(request), schemaRegistry },
        ),
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
      const result = parseResponse(
        "registered path patch",
        registeredPathPatchResponseSchema,
        await configService.patchRegisteredPath(
          request.layer ?? "platform",
          request.path,
          request.value,
          { ...writeContext(request), schemaRegistry },
        ),
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
      const denied = registeredReadDenied(req, deps, metadata.anchorPath);
      if (denied) return denied;
      if (!schemaRegistry) return unavailable(configService);
      const request = parseRegisteredEffectiveRequest(metadata);
      const validation = parseResponse(
        "registered effective validation",
        registeredEffectiveValidationResponseSchema,
        await configService.validateRegisteredEffective(
          request.anchorPath,
          effectiveValidationContext(request, schemaRegistry),
        ),
      );
      return v1Response(
        configService,
        validation.valid ? 200 : 422,
        validation,
      );
    },
  };
}

function registrationContext(req: RestRequest) {
  const identity = req.authContext?.identity;
  if (!identity) return undefined;
  const subject = identity.serviceId ?? identity.userId;
  return subject ? { subject, actor: subject } : undefined;
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

function registrationFailure(
  configService: WeaverConfigService,
  result: SchemaRegistrationResponse,
): RestResponse {
  return v1Error(
    configService,
    "VALIDATION_ERROR",
    result.error?.message ?? "Schema registration failed",
    result.error?.details,
  );
}
