import {
  type ConfigurationPropertySchema,
  fragmentSchemaRegistrationRequestSchema,
  publicConfigPathSchema,
  type RegisteredEffectiveValidationResponse,
  registeredEffectiveValidationRequestSchema,
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteRequestSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchRequestSchema,
  registeredPathPatchResponseSchema,
  registeredSchemasResponseSchema,
  type SchemaRegistrationRequest,
  type SchemaRegistrationResponse,
  type ScopeInstance,
  schemaRegistrationResponseSchema,
  serviceSchemaRegistrationRequestSchema,
} from "@weaver-conf/config-types";
import { type RefinementCtx, z } from "zod";
import type { HttpServerError, ValidatedRequestOptions } from "./http-request";
import type {
  EffectiveValidationOptions,
  WriteOptions,
  WriteResult,
} from "./transport";

const effectiveValidationStatuses = new Set([422]);
const forbiddenOwnKeys = new Set(["__proto__", "constructor", "prototype"]);
const percentTripletPattern = /%[0-9A-Fa-f]{2}/;
const controlPattern = /\p{Cc}/u;
const pcharPattern = /^[A-Za-z0-9._~!$&'()*+,;=:@-]$/;
const wirePathSegmentSchema = z
  .string()
  .refine(
    (segment) =>
      !segment.includes("\\") &&
      !controlPattern.test(segment) &&
      !percentTripletPattern.test(segment),
    "Path segment cannot be represented by the canonical HTTP encoding",
  );

export interface HttpRegisteredContext {
  queryString(params: Record<string, string | undefined>): string;
  requestValidated<T>(
    method: string,
    path: string,
    responseSchema: z.ZodType<T>,
    body?: unknown,
    options?: ValidatedRequestOptions<T>,
  ): Promise<T>;
}

export async function fetchRegisteredSchemas(
  context: HttpRegisteredContext,
): Promise<Record<string, ConfigurationPropertySchema>> {
  const result = await context.requestValidated(
    "GET",
    "/v1/admin/schemas",
    registeredSchemasResponseSchema,
  );
  return result.schemas;
}

export function postSchemaRegistration(
  context: HttpRegisteredContext,
  requestBody: SchemaRegistrationRequest,
): Promise<SchemaRegistrationResponse> {
  const request = parseRegistrationRequest(requestBody);
  const path =
    "providerId" in request
      ? "/v1/admin/schemas/fragments"
      : "/v1/admin/schemas/services";
  return context.requestValidated(
    "POST",
    path,
    schemaRegistrationResponseSchema,
    request,
    { mapServerError: failedRegistration },
  );
}

export function putRegisteredObject(
  context: HttpRegisteredContext,
  anchorPath: string,
  value: unknown,
  options?: WriteOptions,
): Promise<WriteResult> {
  const request = parseRequest(registeredObjectWriteRequestSchema, {
    ...options,
    anchorPath,
    value,
  });
  return writeRequest(context, "PUT", request.anchorPath, request);
}

export function patchRegisteredPath(
  context: HttpRegisteredContext,
  path: string,
  value: unknown,
  options?: WriteOptions,
): Promise<WriteResult> {
  const request = parseRequest(registeredPathPatchRequestSchema, {
    ...options,
    path,
    value,
  });
  return writeRequest(context, "PATCH", request.path, request);
}

export function validateRegisteredEffective(
  context: HttpRegisteredContext,
  options: EffectiveValidationOptions,
): Promise<RegisteredEffectiveValidationResponse> {
  const scope = registeredScopeQuery(options.scopePath);
  const request = parseRequest(registeredEffectiveValidationRequestSchema, {
    anchorPath: options.anchorPath,
    environment: options.environment,
    scope: scope || undefined,
  });
  const query = context.queryString({
    env: request.environment,
    scope: request.scope,
  });
  return context.requestValidated(
    "GET",
    `/v1/registered/effective${wirePath(request.anchorPath)}${query}`,
    registeredEffectiveValidationResponseSchema,
    undefined,
    { acceptedStatuses: effectiveValidationStatuses },
  );
}

function registeredScopeQuery(scopePath?: ScopeInstance[]): string {
  return (
    scopePath?.map(({ scopeId, value }) => `${scopeId}:${value}`).join(",") ??
    ""
  );
}

interface ParsedWriteRequest {
  readonly value: unknown;
  readonly layer?: string | undefined;
  readonly environment?: string | undefined;
  readonly ifRevision?: string | undefined;
}

function writeRequest(
  context: HttpRegisteredContext,
  method: "PUT" | "PATCH",
  path: string,
  request: ParsedWriteRequest,
): Promise<WriteResult> {
  const query = context.queryString({
    layer: request.layer,
    env: request.environment,
  });
  const headers: Record<string, string> = {};
  if (request.ifRevision) headers["If-Match"] = `"${request.ifRevision}"`;
  const responseSchema =
    method === "PUT"
      ? registeredObjectWriteResponseSchema
      : registeredPathPatchResponseSchema;
  const route = method === "PUT" ? "objects" : "paths";
  return context.requestValidated<WriteResult>(
    method,
    `/v1/registered/${route}${wirePath(path)}${query}`,
    responseSchema,
    { value: request.value },
    { headers, mapServerError: failedWrite },
  );
}

function parseRegistrationRequest(
  request: SchemaRegistrationRequest,
): SchemaRegistrationRequest {
  if (Object.hasOwn(request, "providerId")) {
    return parseRequest(fragmentSchemaRegistrationRequestSchema, request);
  }
  return parseRequest(serviceSchemaRegistrationRequestSchema, request);
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  return z
    .unknown()
    .superRefine(rejectForbiddenOwnKeys)
    .pipe(schema)
    .parse(value);
}

function rejectForbiddenOwnKeys(value: unknown, context: RefinementCtx): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (!forbiddenOwnKeys.has(key)) continue;
    context.addIssue({
      code: "custom",
      path: [key],
      message: `Property '${key}' is not allowed`,
    });
  }
}

function failedWrite(error: HttpServerError): WriteResult {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}

function failedRegistration(
  error: HttpServerError,
): SchemaRegistrationResponse {
  return {
    success: false,
    isNewSchema: false,
    hasBreakingChanges: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}

function wirePath(path: string): string {
  const parsed = publicConfigPathSchema.parse(path);
  const segments = parsed.slice(1).split("/");
  if (segments.at(-1) === "") segments.pop();
  return `/${segments.map(encodeWireSegment).join("/")}`;
}

function encodeWireSegment(segment: string): string {
  const validated = wirePathSegmentSchema.parse(segment);
  let encoded = "";
  for (const character of validated) {
    if (pcharPattern.test(character)) encoded += character;
    else encoded += encodeUtf8(character);
  }
  return encoded;
}

function encodeUtf8(character: string): string {
  return [...new TextEncoder().encode(character)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}
