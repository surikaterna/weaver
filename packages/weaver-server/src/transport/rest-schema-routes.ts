import {
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchResponseSchema,
  registeredSchemasResponseSchema,
  type SchemaRegistrationResponse,
  schemaRegistrationResponseSchema,
  type WriteResult,
} from "@weaver-conf/config-types";
import type { z } from "zod";
import type {
  EffectiveValidationContext,
  WeaverConfigService,
  WriteContext,
} from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
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

function writeContext(req: RestRequest): WriteContext {
  const expectedRevision = extractExpectedRevision(req);
  const environment = req.query.env;
  return {
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(environment ? { environment } : {}),
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
    async handler() {
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
      if (!schemaRegistry) return unavailable(configService);
      const body = registeredObjectWriteBodySchema.parse(req.body);
      const result = parseResponse(
        "registered object write",
        registeredObjectWriteResponseSchema,
        await configService.setRegisteredObject(
          req.query.layer ?? "platform",
          canonicalRoutePath(req.params, "anchorPath"),
          body.value,
          { ...writeContext(req), schemaRegistry },
        ),
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
      const body = registeredPathPatchBodySchema.parse(req.body);
      const result = parseResponse(
        "registered path patch",
        registeredPathPatchResponseSchema,
        await configService.patchRegisteredPath(
          req.query.layer ?? "platform",
          canonicalRoutePath(req.params, "path"),
          body.value,
          { ...writeContext(req), schemaRegistry },
        ),
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
      const validation = parseResponse(
        "registered effective validation",
        registeredEffectiveValidationResponseSchema,
        await configService.validateRegisteredEffective(
          canonicalRoutePath(req.params, "anchorPath"),
          effectiveValidationContext(req, schemaRegistry),
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
  result: SchemaRegistrationResponse,
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
