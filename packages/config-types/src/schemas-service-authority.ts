import { z } from "zod";
import { configurationRoleSchema } from "./schemas-policy";
import { configurationServiceIdentitySchema } from "./schemas-service-capabilities";
import {
  canonicalConfigurationPathSchema,
  configurationNamespaceSchema,
  configurationViewIdSchema,
} from "./schemas-service-paths";
import { schemaAuthorizationRequestSchema } from "./schemas-service-schema-authority";
import { sessionAuthorizationRequestSchema } from "./schemas-service-sessions";
import type {
  ConfigurationAuthorityCapability,
  ConfigurationAuthorityController,
  ConfigurationHostAuthority,
} from "./service-authority";
import { serviceDataBoundary } from "./service-data-boundary";

const names = z.array(z.string().min(1)).readonly();
const operation = z.enum(["read", "inspect", "write"]);
export const authorityGrantSchema = serviceDataBoundary(
  z
    .strictObject({
      identity: configurationServiceIdentitySchema,
      namespace: configurationNamespaceSchema,
      operations: z.array(operation).readonly(),
      layers: names,
      views: z.array(configurationViewIdSchema).readonly(),
      sensitive: z.boolean(),
    })
    .refine(
      (grant) =>
        grant.namespace !== "/" ||
        (!grant.operations.includes("write") && grant.views.length === 0),
      { message: "Root grants are base read/inspect only" },
    )
    .readonly(),
);
export const trustedPrincipalSnapshotSchema = serviceDataBoundary(
  z
    .strictObject({
      principalId: z.string().min(1),
      roles: z.array(configurationRoleSchema).readonly(),
      grants: z.array(authorityGrantSchema).readonly(),
      schemaPermissions: z
        .array(z.enum(["read", "register"]))
        .readonly()
        .optional(),
      sessionPermissions: z
        .array(
          z.enum([
            "read",
            "activate",
            "extend",
            "deactivate",
            "emergency",
            "manage",
          ]),
        )
        .readonly()
        .optional(),
      expiresAt: z.number().finite().optional(),
    })
    .readonly(),
);
export const authorizationDecisionSchema = z.enum(["allowed", "denied"]);
const configurationSelection = {
  identity: configurationServiceIdentitySchema,
  namespace: configurationNamespaceSchema,
  path: configurationNamespaceSchema,
  layer: z.string().min(1).optional(),
  viewId: configurationViewIdSchema.optional(),
  sensitive: z.boolean(),
};
export const configurationAuthorizationRequestSchema = serviceDataBoundary(
  z.discriminatedUnion("operation", [
    z
      .strictObject({
        ...configurationSelection,
        operation: z.enum(["read", "inspect"]),
      })
      .readonly(),
    z
      .strictObject({
        ...configurationSelection,
        operation: z.literal("write"),
        namespace: canonicalConfigurationPathSchema,
        path: canonicalConfigurationPathSchema,
        mutation: z.enum(["set", "remove", "patch"]),
        sessionId: z.string().uuid().optional(),
      })
      .readonly(),
  ]),
);
export const authorizationRequestSchema = z.union([
  configurationAuthorizationRequestSchema,
  schemaAuthorizationRequestSchema,
  sessionAuthorizationRequestSchema,
]);
export const configurationAuthorityAuditRecordSchema = serviceDataBoundary(
  z
    .strictObject({
      principalId: z.string().min(1),
      request: authorizationRequestSchema,
      phase: z.enum(["denied", "before-dispatch", "committed", "unknown"]),
      commandIndex: z.number().int().nonnegative().optional(),
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
    forIdentity: callable<ConfigurationAuthorityController["forIdentity"]>(),
    forSchemas: callable<ConfigurationAuthorityController["forSchemas"]>(),
    forMutations: callable<ConfigurationAuthorityController["forMutations"]>(),
    forSessions: callable<ConfigurationAuthorityController["forSessions"]>(),
  }),
);
