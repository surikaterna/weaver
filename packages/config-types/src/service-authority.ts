import type { z } from "zod";
import type {
  authorityGrantSchema,
  authorizationDecisionSchema,
  authorizationRequestSchema,
  configurationAuthorityAuditRecordSchema,
  configurationAuthorizationRequestSchema,
  trustedPrincipalSnapshotSchema,
} from "./schemas-service-authority";
import type { ConfigurationMutationAuthority } from "./service-mutations";
import type {
  ConfigurationReader,
  ConfigurationReaderSelection,
} from "./service-readers";
import type { ConfigurationSchemaAuthorityRequest } from "./service-schema-authority";

export type AuthorityGrant = z.infer<typeof authorityGrantSchema>;
export type TrustedPrincipalSnapshot = z.infer<
  typeof trustedPrincipalSnapshotSchema
>;
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>;
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type ConfigurationAuthorizationRequest = z.infer<
  typeof configurationAuthorizationRequestSchema
>;
export type ConfigurationAuthorityAuditRecord = z.infer<
  typeof configurationAuthorityAuditRecordSchema
>;

declare const authorityCapability: unique symbol;
/** Only membership in the issuing root authenticates this opaque object. */
export interface ConfigurationAuthorityCapability {
  readonly [authorityCapability]: true;
}

export interface ConfigurationAuthorityController {
  forMutations(
    capability: ConfigurationAuthorityCapability,
  ): ConfigurationMutationAuthority;
  forSchemas(
    capability: ConfigurationAuthorityCapability,
  ): ConfigurationSchemaAuthorityRequest;
  mint(snapshot: TrustedPrincipalSnapshot): ConfigurationAuthorityCapability;
  revoke(capability: ConfigurationAuthorityCapability): void;
  replace(
    capability: ConfigurationAuthorityCapability,
    snapshot: TrustedPrincipalSnapshot,
  ): ConfigurationAuthorityCapability;
  forIdentity(
    capability: ConfigurationAuthorityCapability,
    selection: ConfigurationReaderSelection,
  ): ConfigurationReader;
}

export interface ConfigurationHostAuthority {
  authorizeReadSync(
    snapshot: TrustedPrincipalSnapshot,
    request: AuthorizationRequest,
  ): AuthorizationDecision;
  authorizeWrite(
    snapshot: TrustedPrincipalSnapshot,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision>;
}
