import type { z } from "zod";
import type { RegisteredSchemaIdentityPageRequest } from "./registered-operations";
import type { SchemaRegistrationRequest } from "./schema-registration";
import type {
  schemaAuthorizationRequestSchema,
  schemaDetailSchema,
  schemaIdentityPageSchema,
  schemaOperationOptionsSchema,
  schemaOperationResultSchema,
  schemaSnapshotSchema,
} from "./schemas-service-schema-authority";

export type SchemaAuthorizationRequest = z.infer<
  typeof schemaAuthorizationRequestSchema
>;
export type SchemaOperationOptions = z.infer<
  typeof schemaOperationOptionsSchema
>;
export type SchemaOperationResult = z.infer<typeof schemaOperationResultSchema>;
export type SchemaSnapshot = z.infer<typeof schemaSnapshotSchema>;
export type SchemaIdentityPage = z.infer<typeof schemaIdentityPageSchema>;
export type SchemaDetail = z.infer<typeof schemaDetailSchema>;
export interface ConfigurationSchemaAuthorityRequest {
  readonly revision: string;
  register(
    request: SchemaRegistrationRequest,
    options?: SchemaOperationOptions,
  ): Promise<SchemaOperationResult>;
  snapshot(): SchemaSnapshot;
  list(request?: RegisteredSchemaIdentityPageRequest): SchemaIdentityPage;
  get(
    anchorPath: string,
    environment: string,
    options?: SchemaOperationOptions,
  ): SchemaDetail;
}
