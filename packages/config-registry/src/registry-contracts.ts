import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
  RegisteredSchemaDetailResponse,
  RegisteredSchemaIdentityListResponse,
  RegisteredSchemaIdentityPageRequest,
  RegisteredSchemaIdentityPageResponse,
  SchemaRegistrationMetadata,
  SchemaRegistrationRequest,
  WeaverError,
} from "@weaver-conf/config-types";
import {
  fragmentSchemaRegistrationRequestSchema,
  objectConfigurationPropertySchemaSchema,
  registrationEnvironmentSchema,
  schemaRegistrationMetadataSchema,
  serviceSchemaRegistrationRequestSchema,
  weaverErrorSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";

export type {
  SchemaRegistrationAuditMetadata,
  SchemaRegistrationRequest,
} from "@weaver-conf/config-types";

export interface SchemaRegistrationContext {
  readonly subject?: string | undefined;
  readonly actor?: string | undefined;
}

export const schemaRegistrationContextSchema: z.ZodType<SchemaRegistrationContext> =
  z.strictObject({
    subject: z.string().optional(),
    actor: z.string().optional(),
  });

export interface SchemaRegistrationResult {
  success: boolean;
  isNewSchema: boolean;
  hasBreakingChanges: boolean;
  metadata?: SchemaRegistrationMetadata | undefined;
  breakingChanges?: string[];
  error?: WeaverError;
}

export const schemaRegistrationResultSchema: z.ZodType<SchemaRegistrationResult> =
  z
    .strictObject({
      success: z.boolean(),
      isNewSchema: z.boolean(),
      hasBreakingChanges: z.boolean(),
      metadata: schemaRegistrationMetadataSchema.optional(),
      breakingChanges: z.array(z.string()).optional(),
      error: weaverErrorSchema.optional(),
    })
    .transform(({ breakingChanges, error, ...data }) => ({
      ...data,
      ...(breakingChanges !== undefined ? { breakingChanges } : {}),
      ...(error !== undefined ? { error } : {}),
    }));

export const schemaRegistrationRequestSchema: z.ZodType<SchemaRegistrationRequest> =
  z.union([
    serviceSchemaRegistrationRequestSchema,
    fragmentSchemaRegistrationRequestSchema,
  ]);

export interface RegisteredSchemaAnchor {
  readonly kind: "service" | "fragment";
  readonly path: string;
  readonly schema: ObjectConfigurationPropertySchema;
  readonly environment: string;
  readonly metadata: SchemaRegistrationMetadata;
}

export const registeredSchemaAnchorSchema: z.ZodType<RegisteredSchemaAnchor> =
  z.strictObject({
    kind: z.enum(["service", "fragment"]),
    path: z.string(),
    schema: objectConfigurationPropertySchemaSchema,
    environment: z.string(),
    metadata: schemaRegistrationMetadataSchema,
  });

export const canonicalSchemaRegistryOptionsSchema = z.strictObject({
  defaultEnvironment: registrationEnvironmentSchema,
  schemaIdentityMaxPageSize: z.number().int().positive().safe().optional(),
});
export type CanonicalSchemaRegistryOptions = z.infer<
  typeof canonicalSchemaRegistryOptionsSchema
>;

// Readers are executable capabilities, not serializable schema snapshots.
export interface CanonicalSchemaRegistryReader {
  getSchema(
    serviceId: string,
    environment: string,
  ): ObjectConfigurationPropertySchema | null;
  resolveAnchor(
    path: string,
    environment?: string,
  ): RegisteredSchemaAnchor | null;
  listAll(): Record<string, ConfigurationPropertySchema>;
  listRegisteredSchemaIdentities(): RegisteredSchemaIdentityListResponse;
  listRegisteredSchemaIdentityPage(
    input?: RegisteredSchemaIdentityPageRequest,
  ): RegisteredSchemaIdentityPageResponse;
  getRegisteredSchema(
    path: string,
    environment: string,
  ): RegisteredSchemaDetailResponse | null;
}

export interface CanonicalSchemaRegistry extends CanonicalSchemaRegistryReader {
  register(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
  ): SchemaRegistrationResult;
}
