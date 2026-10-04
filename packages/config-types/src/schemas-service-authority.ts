import { z } from "zod";
import { configurationRoleSchema } from "./schemas-policy";
import { configurationServiceIdentitySchema } from "./schemas-service-capabilities";
import { canonicalConfigurationPathSchema } from "./schemas-service-paths";
import type {
  ConfigurationAuthorityCapability,
  ConfigurationAuthorityController,
  ConfigurationAuthorityRequest,
  ConfigurationHostAuthority,
} from "./service-authority";
import { serviceDataBoundary } from "./service-data-boundary";

const names = z.array(z.string().min(1)).readonly();
const operation = z.enum(["read", "inspect", "write"]);
export const authorityGrantSchema = serviceDataBoundary(
  z
    .strictObject({
      identity: configurationServiceIdentitySchema,
      namespace: canonicalConfigurationPathSchema,
      operations: z.array(operation).readonly(),
      layers: names,
      views: names,
      sensitive: z.boolean(),
    })
    .readonly(),
);
export const trustedPrincipalSnapshotSchema = serviceDataBoundary(
  z
    .strictObject({
      principalId: z.string().min(1),
      roles: z.array(configurationRoleSchema).readonly(),
      grants: z.array(authorityGrantSchema).readonly(),
      session: z
        .strictObject({
          mode: z.string().min(1),
          overrideReason: z.string().min(1),
        })
        .readonly()
        .optional(),
      expiresAt: z.number().finite().optional(),
    })
    .readonly(),
);
export const authorizationDecisionSchema = z.enum(["allowed", "denied"]);
export const authorizationRequestSchema = serviceDataBoundary(
  z
    .strictObject({
      identity: configurationServiceIdentitySchema,
      namespace: canonicalConfigurationPathSchema,
      path: canonicalConfigurationPathSchema,
      operation,
      layer: z.string().min(1).optional(),
      viewId: z.string().min(1).optional(),
      sensitive: z.boolean(),
    })
    .readonly(),
);
export const configurationAuthorityAuditRecordSchema = serviceDataBoundary(
  z
    .strictObject({
      principalId: z.string().min(1),
      request: authorizationRequestSchema,
      phase: z.enum(["denied", "before-dispatch", "committed", "unknown"]),
    })
    .readonly(),
);

/** No root-independent parser can authenticate a capability, even a genuine one. */
export const configurationAuthorityCapabilitySchema =
  z.custom<ConfigurationAuthorityCapability>(() => false);
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}
/** Callable shapes only; these schemas neither invoke callbacks nor mint grants. */
export const configurationHostAuthoritySchema = serviceDataBoundary(
  z.strictObject({
    authorizeReadSync:
      callable<ConfigurationHostAuthority["authorizeReadSync"]>(),
    authorizeWrite: callable<ConfigurationHostAuthority["authorizeWrite"]>(),
  }),
);
export const configurationAuthorityControllerSchema = serviceDataBoundary(
  z.strictObject({
    mint: callable<ConfigurationAuthorityController["mint"]>(),
    revoke: callable<ConfigurationAuthorityController["revoke"]>(),
    replace: callable<ConfigurationAuthorityController["replace"]>(),
    bindRoot: callable<ConfigurationAuthorityController["bindRoot"]>(),
    forIdentity: callable<ConfigurationAuthorityController["forIdentity"]>(),
  }),
);
export const configurationAuthorityRequestSchema = serviceDataBoundary(
  z.strictObject({
    identity: configurationServiceIdentitySchema,
    revision: z.string().min(1),
    prepare: callable<ConfigurationAuthorityRequest["prepare"]>(),
    get: callable<ConfigurationAuthorityRequest["get"]>(),
    inspect: callable<ConfigurationAuthorityRequest["inspect"]>(),
    set: callable<ConfigurationAuthorityRequest["set"]>(),
    remove: callable<ConfigurationAuthorityRequest["remove"]>(),
  }),
);
