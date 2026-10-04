import type { z } from "zod";
import type {
  authorityGrantSchema,
  authorizationDecisionSchema,
  authorizationRequestSchema,
  configurationAuthorityAuditRecordSchema,
  trustedPrincipalSnapshotSchema,
} from "./schemas-service-authority";
import type {
  ConfigurationServiceIdentity,
  ConfigurationServiceWriteOptions,
  ConfigurationServiceWriteResult,
  HydratedConfigurationInspection,
} from "./service-capabilities";
import type { CanonicalConfigurationPath } from "./service-paths";

export type AuthorityGrant = z.infer<typeof authorityGrantSchema>;
export type TrustedPrincipalSnapshot = z.infer<
  typeof trustedPrincipalSnapshotSchema
>;
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>;
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type ConfigurationAuthorityAuditRecord = z.infer<
  typeof configurationAuthorityAuditRecordSchema
>;

declare const authorityCapability: unique symbol;
/** Only membership in the issuing root authenticates this opaque object. */
export interface ConfigurationAuthorityCapability {
  readonly [authorityCapability]: true;
}

/** Trusted host request port, not a consumer factory or an identity verifier. */
export interface ConfigurationAuthorityRequest {
  readonly identity: ConfigurationServiceIdentity;
  readonly revision: string;
  prepare(): Promise<void>;
  get(path: CanonicalConfigurationPath): unknown;
  inspect(path: CanonicalConfigurationPath): HydratedConfigurationInspection;
  set(
    path: CanonicalConfigurationPath,
    value: unknown,
    options: ConfigurationServiceWriteOptions,
  ): Promise<ConfigurationServiceWriteResult>;
  remove(
    path: CanonicalConfigurationPath,
    options: ConfigurationServiceWriteOptions,
  ): Promise<ConfigurationServiceWriteResult>;
}

export interface ConfigurationAuthorityController {
  mint(snapshot: TrustedPrincipalSnapshot): ConfigurationAuthorityCapability;
  revoke(capability: ConfigurationAuthorityCapability): void;
  replace(
    capability: ConfigurationAuthorityCapability,
    snapshot: TrustedPrincipalSnapshot,
  ): ConfigurationAuthorityCapability;
  bindRoot(capability: ConfigurationAuthorityCapability): void;
  forIdentity(
    capability: ConfigurationAuthorityCapability,
    identity: ConfigurationServiceIdentity,
    namespace: CanonicalConfigurationPath,
  ): ConfigurationAuthorityRequest;
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
