import type { ConfigurationPropertySchema } from "./property-schema";
import type { WriteResult } from "./providers";
import type { SchemaValidationResult } from "./schema-validation";

export interface RegisteredSchemasResponse {
  readonly schemas: Record<string, ConfigurationPropertySchema>;
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
