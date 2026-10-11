import { z } from "zod";
import { weaverErrorSchema } from "./errors";
import {
  registeredSchemaDetailResponseSchema,
  registeredSchemaIdentityPageResponseSchema,
} from "./schemas-registered-operations";
import { registrationEnvironmentSchema } from "./schemas-registration-paths";
import {
  fragmentSlotRegistrationMetadataSchema,
  schemaRegistrationMetadataSchema,
} from "./schemas-schema-registration";
import { canonicalConfigurationPathSchema } from "./schemas-service-paths";
import { serviceDataBoundary } from "./service-data-boundary";
import type { ConfigurationSchemaAuthorityRequest } from "./service-schema-authority";

export const schemaOperationOptionsSchema = serviceDataBoundary(
  z.strictObject({ ifRevision: z.string().min(1).optional() }).readonly(),
);
export const schemaAuthorizationRequestSchema = serviceDataBoundary(
  z.union([
    z
      .strictObject({
        operation: z.literal("schema-read"),
        query: z.enum(["snapshot", "list"]),
      })
      .readonly(),
    z
      .strictObject({
        operation: z.literal("schema-read"),
        query: z.literal("get"),
        anchorPath: canonicalConfigurationPathSchema,
        environment: registrationEnvironmentSchema,
      })
      .readonly(),
    z
      .strictObject({
        operation: z.literal("schema-register"),
        kind: z.enum(["service", "fragment"]),
        anchorPath: canonicalConfigurationPathSchema,
        environment: registrationEnvironmentSchema,
      })
      .readonly(),
  ]),
);
export const schemaOperationResultSchema = z.discriminatedUnion("success", [
  z
    .strictObject({
      success: z.literal(true),
      revision: z.string().min(1),
      isNewSchema: z.boolean(),
      hasBreakingChanges: z.boolean(),
      metadata: schemaRegistrationMetadataSchema,
      breakingChanges: z.array(z.string()).optional(),
    })
    .readonly(),
  z
    .strictObject({
      success: z.literal(false),
      outcome: z.enum(["rejected", "unknown"]),
      error: weaverErrorSchema,
    })
    .readonly(),
]);
export const schemaSnapshotSchema = z
  .strictObject({
    revision: z.string().min(1),
    anchors: z.array(registeredSchemaDetailResponseSchema).readonly(),
    slots: z.array(fragmentSlotRegistrationMetadataSchema).readonly(),
  })
  .readonly();
export const schemaIdentityPageSchema = z
  .strictObject({
    revision: z.string().min(1),
    page: registeredSchemaIdentityPageResponseSchema,
  })
  .readonly();
export const schemaDetailSchema = z
  .strictObject({
    revision: z.string().min(1),
    detail: registeredSchemaDetailResponseSchema.nullable(),
  })
  .readonly();
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}
export const configurationSchemaAuthorityRequestSchema = serviceDataBoundary(
  z.strictObject({
    revision: z.string().min(1),
    register: callable<ConfigurationSchemaAuthorityRequest["register"]>(),
    snapshot: callable<ConfigurationSchemaAuthorityRequest["snapshot"]>(),
    list: callable<ConfigurationSchemaAuthorityRequest["list"]>(),
    get: callable<ConfigurationSchemaAuthorityRequest["get"]>(),
  }),
);
