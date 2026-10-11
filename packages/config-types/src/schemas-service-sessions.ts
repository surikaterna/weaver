import { z } from "zod";
import { configurationServiceIdentitySchema } from "./schemas-service-capabilities";
import {
  canonicalConfigurationPathSchema,
  configurationViewIdSchema,
} from "./schemas-service-paths";
import { serviceDataBoundary } from "./service-data-boundary";
import type { ConfigurationSessionAuthority } from "./service-sessions";

const duration = z.number().int().positive().max(2147483647);
const id = z.string().uuid();
const target = {
  identity: configurationServiceIdentitySchema,
  namespace: canonicalConfigurationPathSchema,
  viewId: configurationViewIdSchema.optional(),
};
export const configurationSessionActivationSchema = serviceDataBoundary(
  z
    .strictObject({
      ...target,
      reason: z.string().trim().min(1),
      durationMs: duration.optional(),
      emergency: z.boolean(),
    })
    .readonly(),
);
export const configurationSessionExtensionSchema = serviceDataBoundary(
  z
    .strictObject({
      sessionId: id,
      durationMs: duration.optional(),
    })
    .readonly(),
);
export const configurationSessionSelectionSchema = serviceDataBoundary(
  z.strictObject({ sessionId: id }).readonly(),
);
export const configurationSessionInfoSchema = serviceDataBoundary(
  z
    .strictObject({
      ...target,
      id,
      layer: z.string().min(1),
      activatedBy: z.string().min(1),
      reason: z.string().min(1),
      activatedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
      followUpDeadline: z.number().int().nonnegative(),
      emergency: z.boolean(),
    })
    .readonly(),
);
export const configurationSessionDeactivationSchema = serviceDataBoundary(
  z
    .strictObject({
      sessionId: id,
      deactivatedAt: z.number().int().nonnegative(),
      overridesCleared: z.number().int().nonnegative(),
    })
    .readonly(),
);
const authorization = {
  ...target,
  layer: z.string().min(1),
  reason: z.string().min(1),
  emergency: z.boolean(),
};
export const sessionAuthorizationRequestSchema = serviceDataBoundary(
  z.discriminatedUnion("operation", [
    z
      .strictObject({
        ...authorization,
        operation: z.literal("session-activate"),
        sessionId: id.optional(),
        durationMs: duration.optional(),
      })
      .readonly(),
    z
      .strictObject({
        ...authorization,
        operation: z.literal("session-extend"),
        sessionId: id,
        durationMs: duration.optional(),
      })
      .readonly(),
    z
      .strictObject({
        ...authorization,
        operation: z.literal("session-deactivate"),
        sessionId: id,
        cause: z
          .enum(["manual", "expired", "revoked", "disposed", "schema-fenced"])
          .optional(),
      })
      .readonly(),
    z
      .strictObject({
        ...authorization,
        operation: z.literal("session-read"),
        sessionId: id,
      })
      .readonly(),
  ]),
);
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}
export const configurationSessionAuthoritySchema = serviceDataBoundary(
  z.strictObject({
    activate: callable<ConfigurationSessionAuthority["activate"]>(),
    extend: callable<ConfigurationSessionAuthority["extend"]>(),
    deactivate: callable<ConfigurationSessionAuthority["deactivate"]>(),
    get: callable<ConfigurationSessionAuthority["get"]>(),
    list: callable<ConfigurationSessionAuthority["list"]>(),
  }),
);
