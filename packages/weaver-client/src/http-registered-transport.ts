import {
  type ConfigurationPropertySchema,
  type FragmentSchemaRegistrationRequest,
  type RegisteredEffectiveValidationResponse,
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchResponseSchema,
  registeredSchemasResponseSchema,
  type SchemaRegistrationRequest,
  type SchemaRegistrationResponse,
  type ScopeInstance,
  type ServiceSchemaRegistrationRequest,
  schemaRegistrationResponseSchema,
} from "@weaver-conf/config-types";
import type { z } from "zod";
import type { HttpServerError, ValidatedRequestOptions } from "./http-request";
import type { WriteOptions, WriteResult } from "./transport";

export interface HttpRegisteredContext {
  buildScopeQuery(scopePath?: ScopeInstance[]): string;
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

export async function postSchemaRegistration(
  context: HttpRegisteredContext,
  requestBody: SchemaRegistrationRequest,
): Promise<SchemaRegistrationResponse> {
  const path =
    "providerId" in requestBody
      ? "/v1/admin/schemas/fragments"
      : "/v1/admin/schemas/services";
  return context.requestValidated(
    "POST",
    path,
    schemaRegistrationResponseSchema,
    requestBody,
    { mapServerError: failedRegistration },
  );
}

export function postServiceSchemaRegistration(
  context: HttpRegisteredContext,
  requestBody: ServiceSchemaRegistrationRequest,
): Promise<SchemaRegistrationResponse> {
  return postSchemaRegistration(context, requestBody);
}

export function postFragmentSchemaRegistration(
  context: HttpRegisteredContext,
  requestBody: FragmentSchemaRegistrationRequest,
): Promise<SchemaRegistrationResponse> {
  return postSchemaRegistration(context, requestBody);
}

export function putRegisteredObject(
  context: HttpRegisteredContext,
  anchorPath: string,
  value: unknown,
  opts?: WriteOptions,
): Promise<WriteResult> {
  const path = canonicalPathUrl(anchorPath);
  const qs = context.queryString({
    layer: opts?.layer,
    env: opts?.environment,
  });
  return writeRequest(
    context,
    "PUT",
    `/v1/registered/objects${path}${qs}`,
    value,
    opts,
  );
}

export function patchRegisteredPath(
  context: HttpRegisteredContext,
  path: string,
  value: unknown,
  opts?: WriteOptions,
): Promise<WriteResult> {
  const canonicalPath = canonicalPathUrl(path);
  const qs = context.queryString({
    layer: opts?.layer,
    env: opts?.environment,
  });
  return writeRequest(
    context,
    "PATCH",
    `/v1/registered/paths${canonicalPath}${qs}`,
    value,
    opts,
  );
}

export function validateRegisteredEffective(
  context: HttpRegisteredContext,
  options: {
    anchorPath: string;
    environment?: string;
    scopePath?: ScopeInstance[];
  },
): Promise<RegisteredEffectiveValidationResponse> {
  const scope = context.buildScopeQuery(options.scopePath);
  const qs = context.queryString({
    environment: options.environment,
    scope: scope || undefined,
  });
  const path = canonicalPathUrl(options.anchorPath);
  return context.requestValidated(
    "GET",
    `/v1/registered/effective${path}${qs}`,
    registeredEffectiveValidationResponseSchema,
  );
}

async function writeRequest(
  context: HttpRegisteredContext,
  method: "PUT" | "PATCH",
  path: string,
  value: unknown,
  opts?: WriteOptions,
): Promise<WriteResult> {
  const headers: Record<string, string> = {};
  if (opts?.ifRevision) headers["If-Match"] = `"${opts.ifRevision}"`;
  const responseSchema =
    method === "PUT"
      ? registeredObjectWriteResponseSchema
      : registeredPathPatchResponseSchema;
  return context.requestValidated<WriteResult>(
    method,
    path,
    responseSchema,
    { value },
    {
      headers,
      mapServerError: failedWrite,
    },
  );
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
      code: "VALIDATION_ERROR",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function canonicalPathUrl(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
