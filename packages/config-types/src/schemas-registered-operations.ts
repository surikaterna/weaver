import { z } from "zod";
import type {
  RegisteredSchemaDetailRequest,
  RegisteredSchemaDetailResponse,
  RegisteredSchemaIdentity,
  RegisteredSchemaIdentityListResponse,
  RegisteredSchemaIdentityPageRequest,
  RegisteredSchemaIdentityPageResponse,
  RegisteredSchemaSlotIdentity,
  RegisteredSchemasResponse,
} from "./registered-operations";
import {
  configurationPropertySchemaSchema,
  objectConfigurationPropertySchemaSchema,
} from "./schemas-property";
import { writeResultSchema } from "./schemas-providers";
import {
  publicConfigPathSchema,
  registrationEnvironmentSchema,
} from "./schemas-registration-paths";
import { schemaRegistrationMetadataSchema } from "./schemas-schema-registration";
import { schemaValidationResultSchema } from "./schemas-schema-validation";

const registeredAnchorPathSchema = publicConfigPathSchema.refine(
  (path) =>
    !path.endsWith("/") &&
    path
      .slice(1)
      .split("/")
      .every(
        (segment) =>
          segment !== "." &&
          segment !== ".." &&
          !segment.includes("\\") &&
          !/%[0-9A-Fa-f]{2}/.test(segment) &&
          !/\p{Cc}/u.test(segment),
      ),
  "Anchor path must use canonical, unambiguous segments",
);

const identityFields = {
  kind: z.enum(["service", "fragment"]),
  path: registeredAnchorPathSchema,
  environment: registrationEnvironmentSchema,
};

export const registeredSchemaIdentitySchema: z.ZodType<RegisteredSchemaIdentity> =
  z.strictObject(identityFields);

export const registeredSchemaSlotIdentitySchema: z.ZodType<RegisteredSchemaSlotIdentity> =
  z.strictObject({
    kind: z.literal("slot"),
    path: registeredAnchorPathSchema,
    environment: registrationEnvironmentSchema,
    accepts: z.literal("object"),
  });

export const registeredSchemaIdentityListResponseSchema: z.ZodType<RegisteredSchemaIdentityListResponse> =
  z.strictObject({
    anchors: z.array(registeredSchemaIdentitySchema),
    slots: z.array(registeredSchemaSlotIdentitySchema),
  });

export const registeredSchemaIdentityPageRequestSchema: z.ZodType<RegisteredSchemaIdentityPageRequest> =
  z.strictObject({
    limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{55}$/)
      .optional(),
  });

export const registeredSchemaIdentityPageResponseSchema: z.ZodType<RegisteredSchemaIdentityPageResponse> =
  z
    .strictObject({
      anchors: z.array(registeredSchemaIdentitySchema),
      slots: z.array(registeredSchemaSlotIdentitySchema),
      nextCursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{55}$/)
        .nullable(),
      hasMore: z.boolean(),
    })
    .refine((page) => page.hasMore === (page.nextCursor !== null));

export const registeredSchemaDetailRequestSchema: z.ZodType<RegisteredSchemaDetailRequest> =
  z.strictObject({
    anchorPath: registeredAnchorPathSchema,
    environment: registrationEnvironmentSchema,
  });

export const registeredSchemaDetailResponseSchema: z.ZodType<RegisteredSchemaDetailResponse> =
  z.strictObject({
    ...identityFields,
    schema: objectConfigurationPropertySchemaSchema,
    metadata: schemaRegistrationMetadataSchema,
  });

const registeredWriteOptionsSchema = {
  layer: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  ifRevision: z.string().min(1).optional(),
};

export const registeredSchemasResponseSchema: z.ZodType<RegisteredSchemasResponse> =
  z.strictObject({
    schemas: z.record(z.string(), configurationPropertySchemaSchema),
  });

export const registeredObjectWriteRequestSchema = z
  .strictObject({
    anchorPath: publicConfigPathSchema,
    value: z.unknown(),
    ...registeredWriteOptionsSchema,
  })
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

export const registeredPathPatchRequestSchema = z
  .strictObject({
    path: publicConfigPathSchema,
    value: z.unknown(),
    ...registeredWriteOptionsSchema,
  })
  .refine((data) => "value" in data, {
    message: "Missing required field 'value'",
    path: ["value"],
  });

export const registeredEffectiveValidationRequestSchema = z.strictObject({
  anchorPath: publicConfigPathSchema,
  environment: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

export const registeredObjectWriteResponseSchema = writeResultSchema;
export const registeredPathPatchResponseSchema = writeResultSchema;
export const registeredEffectiveValidationResponseSchema =
  schemaValidationResultSchema;
