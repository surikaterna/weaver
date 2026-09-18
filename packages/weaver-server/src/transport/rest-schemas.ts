import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  fragmentSchemaRegistrationRequestSchema,
  publicConfigPathSchema,
  registeredEffectiveValidationRequestSchema,
  registeredObjectWriteRequestSchema,
  registeredPathPatchRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";

/** PUT /v1/config/*keyPath body — value is required */
export const configWriteBodySchema = z
  .object({
    value: z.unknown(),
  })
  .passthrough()
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

/** PATCH /v1/config body — batch write with entries map */
export const configBatchBodySchema = z.object({
  entries: z.record(z.string(), z.unknown()),
});

/** POST /v1/admin/scopes/:scopeId body */
export const scopeProvisionBodySchema = z.object({
  value: z.string().min(1),
  displayName: z.string().optional(),
});

/** POST /v1/admin/schemas/services body */
export const serviceSchemaRegistrationBodySchema = safeTopLevelObject(
  serviceSchemaRegistrationRequestSchema,
);

/** POST /v1/admin/schemas/fragments body */
export const fragmentSchemaRegistrationBodySchema = safeTopLevelObject(
  fragmentSchemaRegistrationRequestSchema,
);

const registeredObjectWriteBodySchema = safeTopLevelObject(
  z.strictObject({ value: z.unknown() }).refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  }),
);

const registeredPathPatchBodySchema = safeTopLevelObject(
  z.strictObject({ value: z.unknown() }).refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  }),
);

const nonemptyString = z.string().min(1);
const scopeQueryString = nonemptyString.regex(
  /^[^,:]+:[^,:]+(?:,[^,:]+:[^,:]+)*$/,
  "Scope must contain comma-separated scope:value pairs",
);
const registeredWriteQuerySchema = safeTopLevelObject(
  z.strictObject({
    layer: nonemptyString.optional(),
    env: nonemptyString.optional(),
  }),
);
const registeredEffectiveQuerySchema = safeTopLevelObject(
  z.strictObject({
    env: nonemptyString.optional(),
    scope: scopeQueryString.optional(),
  }),
);
const adminQuerySchema = safeTopLevelObject(z.strictObject({}));
const registeredWriteMetadataSchema = z.strictObject({
  path: publicConfigPathSchema,
  layer: nonemptyString,
  environment: nonemptyString.optional(),
  ifRevision: nonemptyString.optional(),
});

export interface RegisteredWriteRouteMetadata {
  readonly path: string;
  readonly layer: string;
  readonly environment?: string | undefined;
  readonly ifRevision?: string | undefined;
}

export interface RegisteredEffectiveRouteMetadata {
  readonly anchorPath: string;
  readonly environment?: string | undefined;
  readonly scope?: string | undefined;
}

export function parseAdminQuery(query: unknown): void {
  adminQuerySchema.parse(query);
}

export function parseRegisteredWriteMetadata(
  path: string,
  query: unknown,
  ifRevision: string | undefined,
): RegisteredWriteRouteMetadata {
  const parsedQuery = registeredWriteQuerySchema.parse(query);
  const metadata = registeredWriteMetadataSchema.parse({
    path: canonicalRoutePath(path),
    layer: parsedQuery.layer ?? "platform",
    environment: parsedQuery.env,
    ifRevision,
  });
  return metadata;
}

export function parseRegisteredObjectRequest(
  metadata: RegisteredWriteRouteMetadata,
  body: unknown,
) {
  const parsedBody = registeredObjectWriteBodySchema.parse(body);
  return registeredObjectWriteRequestSchema.parse({
    anchorPath: metadata.path,
    value: parsedBody.value,
    layer: metadata.layer,
    environment: metadata.environment,
    ifRevision: metadata.ifRevision,
  });
}

export function parseRegisteredPathRequest(
  metadata: RegisteredWriteRouteMetadata,
  body: unknown,
) {
  const parsedBody = registeredPathPatchBodySchema.parse(body);
  return registeredPathPatchRequestSchema.parse({
    path: metadata.path,
    value: parsedBody.value,
    layer: metadata.layer,
    environment: metadata.environment,
    ifRevision: metadata.ifRevision,
  });
}

export function parseRegisteredEffectiveMetadata(
  anchorPath: string,
  query: unknown,
): RegisteredEffectiveRouteMetadata {
  const parsedQuery = registeredEffectiveQuerySchema.parse(query);
  return {
    anchorPath: canonicalRoutePath(anchorPath),
    environment: parsedQuery.env,
    scope: parsedQuery.scope,
  };
}

export function parseRegisteredEffectiveRequest(
  metadata: RegisteredEffectiveRouteMetadata,
) {
  return registeredEffectiveValidationRequestSchema.parse(metadata);
}

function canonicalRoutePath(path: string): string {
  const publicPath = publicConfigPathSchema.parse(path);
  return parseCanonicalConfigPath(publicPath).path;
}

function safeTopLevelObject<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .superRefine((value, context) => rejectForbiddenOwnKeys(value, context))
    .pipe(schema);
}

function rejectForbiddenOwnKeys(
  value: unknown,
  context: z.RefinementCtx,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return;
  for (const key of Object.keys(value)) {
    if (!forbiddenOwnKeys.has(key)) continue;
    context.addIssue({
      code: "custom",
      path: [key],
      message: `Property '${key}' is not allowed`,
    });
  }
}

const forbiddenOwnKeys = new Set(["__proto__", "constructor", "prototype"]);
