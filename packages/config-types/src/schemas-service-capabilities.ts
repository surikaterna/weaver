import { z } from "zod";
import { scopeInstanceSchema } from "./schemas-layers";
import { configReloadBehaviorSchema } from "./schemas-policy";
import { registrationEnvironmentSchema } from "./schemas-registration-paths";
import {
  canonicalConfigurationPathSchema,
  configurationNamespaceSchema,
  configurationViewIdSchema,
} from "./schemas-service-paths";
import type { ConfigurationService } from "./service-capabilities";
import { serviceDataBoundary } from "./service-data-boundary";

const nonempty = z.string().min(1);
const scopePathSchema = z
  .array(scopeInstanceSchema.readonly())
  .refine(
    (path) => new Set(path.map((scope) => scope.scopeId)).size === path.length,
    { message: "Duplicate scopeId" },
  )
  .readonly();

export const configurationServiceIdentitySchema = serviceDataBoundary(
  z
    .strictObject({
      environment: registrationEnvironmentSchema,
      scopePath: scopePathSchema,
    })
    .readonly(),
);

const missingShape = { state: z.literal("missing") };
const valueShape = {
  state: z.literal("value"),
  value: z.unknown().refine((value) => value !== undefined),
};
const redactedShape = { state: z.literal("redacted") };
export const configurationInspectionValueSchema = serviceDataBoundary(
  z.discriminatedUnion("state", [
    z.strictObject(missingShape).readonly(),
    z.strictObject(valueShape).readonly(),
    z.strictObject(redactedShape).readonly(),
  ]),
);

const provenance = {
  layer: nonempty,
  providerId: nonempty,
  source: z.enum(["base", "view"]).optional(),
  sourcePath: canonicalConfigurationPathSchema.optional(),
};
export const configurationLayerContributionSchema = serviceDataBoundary(
  z.discriminatedUnion("state", [
    z.strictObject({ ...missingShape, ...provenance }).readonly(),
    z.strictObject({ ...valueShape, ...provenance }).readonly(),
    z.strictObject({ ...redactedShape, ...provenance }).readonly(),
  ]),
);

export const hydratedConfigurationInspectionSchema = serviceDataBoundary(
  z
    .strictObject({
      path: configurationNamespaceSchema,
      identity: configurationServiceIdentitySchema,
      revision: nonempty,
      effective: configurationInspectionValueSchema,
      effectiveLayer: nonempty.optional(),
      namespace: configurationNamespaceSchema.optional(),
      viewId: configurationViewIdSchema.optional(),
      effectiveSource: z.enum(["base", "view"]).optional(),
      contributions: z.array(configurationLayerContributionSchema).readonly(),
    })
    .superRefine((inspection, context) => {
      if (
        inspection.effective.state === "missing" &&
        inspection.effectiveLayer !== undefined
      )
        context.addIssue({
          code: "custom",
          message: "Missing values have no effective layer",
        });
      const pairs = inspection.contributions.map(
        ({ layer, providerId, sourcePath }) =>
          JSON.stringify([layer, providerId, sourcePath]),
      );
      if (new Set(pairs).size !== pairs.length)
        context.addIssue({
          code: "custom",
          message: "Duplicate layer/provider contribution",
        });
    })
    .readonly(),
);

const changeSelection = z
  .strictObject({
    identity: configurationServiceIdentitySchema,
    namespace: configurationNamespaceSchema,
    viewId: configurationViewIdSchema.optional(),
  })
  .readonly();
const changeCommon = {
  selection: changeSelection,
  path: configurationNamespaceSchema,
  previousRevision: nonempty,
  revision: nonempty,
  cause: z.enum([
    "mutation",
    "schema",
    "reload",
    "external",
    "reconcile",
    "session",
  ]),
};
export const configurationReaderChangeSchema = serviceDataBoundary(
  z.discriminatedUnion("kind", [
    z
      .strictObject({
        ...changeCommon,
        kind: z.literal("effective"),
        previous: configurationInspectionValueSchema,
        current: configurationInspectionValueSchema,
        reloadBehavior: configReloadBehaviorSchema,
      })
      .readonly(),
    z
      .strictObject({
        ...changeCommon,
        kind: z.literal("layer"),
        layer: nonempty,
        previous: z.array(configurationLayerContributionSchema).readonly(),
        current: z.array(configurationLayerContributionSchema).readonly(),
      })
      .readonly(),
    z
      .strictObject({
        ...changeCommon,
        kind: z.literal("invalidation"),
        reason: z.enum(["schema", "stale"]),
      })
      .readonly(),
  ]),
);
export const configurationReaderChangeOptionsSchema = serviceDataBoundary(
  z.strictObject({ layer: nonempty.optional() }).readonly(),
);
export const configurationRestartStateSchema = serviceDataBoundary(
  z
    .strictObject({
      revision: nonempty,
      pending: z.enum(["none", "restart-required", "rolling-restart"]),
    })
    .readonly(),
);

/** Callable shape only; parsing does not execute or authenticate capabilities. */
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}

export const configurationServiceSchema = serviceDataBoundary(
  z.strictObject({
    mode: z.enum(["live", "degraded"]),
    degradedProviders: z.array(nonempty).readonly(),
    restartState: configurationRestartStateSchema,
    acknowledgeRestart: callable<ConfigurationService["acknowledgeRestart"]>(),
    reloadProvider: callable<ConfigurationService["reloadProvider"]>(),
    flush: callable<ConfigurationService["flush"]>(),
    dispose: callable<ConfigurationService["dispose"]>(),
  }),
);
