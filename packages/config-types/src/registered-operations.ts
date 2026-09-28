import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
} from "./property-schema";
import type { WriteResult } from "./providers";
import type { SchemaRegistrationMetadata } from "./schema-registration";
import type { SchemaValidationResult } from "./schema-validation";

export interface RegisteredSchemasResponse {
  readonly schemas: Record<string, ConfigurationPropertySchema>;
}

export interface RegisteredSchemaIdentity {
  readonly kind: "service" | "fragment";
  readonly path: string;
  readonly environment: string;
}

export interface RegisteredSchemaSlotIdentity {
  readonly kind: "slot";
  readonly path: string;
  readonly environment: string;
  readonly accepts: "object";
}

export interface RegisteredSchemaIdentityListResponse {
  readonly anchors: ReadonlyArray<RegisteredSchemaIdentity>;
  readonly slots: ReadonlyArray<RegisteredSchemaSlotIdentity>;
}

export interface RegisteredSchemaDetailRequest {
  readonly anchorPath: string;
  readonly environment: string;
}

export interface RegisteredSchemaDetailResponse
  extends RegisteredSchemaIdentity {
  readonly schema: ObjectConfigurationPropertySchema;
  readonly metadata: SchemaRegistrationMetadata;
}

export interface RegisteredWriteOptions {
  readonly layer?: string | undefined;
  readonly environment?: string | undefined;
  readonly ifRevision?: string | undefined;
}

export interface RegisteredObjectWriteRequest extends RegisteredWriteOptions {
  readonly anchorPath: string;
  readonly value: unknown;
}

export interface RegisteredPathPatchRequest extends RegisteredWriteOptions {
  readonly path: string;
  readonly value: unknown;
}

export interface RegisteredEffectiveValidationRequest {
  readonly anchorPath: string;
  readonly environment?: string | undefined;
  readonly scope?: string | undefined;
}

export type RegisteredObjectWriteResponse = WriteResult;
export type RegisteredPathPatchResponse = WriteResult;
export type RegisteredEffectiveValidationResponse = SchemaValidationResult;
