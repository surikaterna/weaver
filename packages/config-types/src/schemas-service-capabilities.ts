import { z } from "zod";
import { weaverErrorSchema } from "./errors";
import { scopeInstanceSchema } from "./schemas-layers";
import { configReloadBehaviorSchema } from "./schemas-policy";
import { registrationEnvironmentSchema } from "./schemas-registration-paths";
import { canonicalConfigurationPathSchema } from "./schemas-service-paths";
import type {
  HydratedConfigurationReader,
  HydratedConfigurationService,
  HydratedScopedConfigurationService,
  HydratedServiceConfigurationService,
} from "./service-capabilities";
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

const provenance = { layer: nonempty, providerId: nonempty };
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
      path: canonicalConfigurationPathSchema,
      identity: configurationServiceIdentitySchema,
      revision: nonempty,
      effective: configurationInspectionValueSchema,
      effectiveLayer: nonempty.optional(),
      contributions: z.array(configurationLayerContributionSchema).readonly(),
    })
    .superRefine((inspection, context) => {
      if (
        inspection.effective.state === "missing" &&
        inspection.effectiveLayer !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Missing values have no effective layer",
        });
      }
      const pairs = inspection.contributions.map(({ layer, providerId }) =>
        JSON.stringify([layer, providerId]),
      );
      if (new Set(pairs).size !== pairs.length) {
        context.addIssue({
          code: "custom",
          message: "Duplicate layer/provider contribution",
        });
      }
    })
    .readonly(),
);

export const configurationEffectiveChangeSchema = serviceDataBoundary(
  z
    .strictObject({
      path: canonicalConfigurationPathSchema,
      identity: configurationServiceIdentitySchema,
      revision: nonempty,
      previous: configurationInspectionValueSchema,
      current: configurationInspectionValueSchema,
      cause: z.enum(["write", "remove", "reload", "external", "session"]),
      reloadBehavior: configReloadBehaviorSchema,
    })
    .readonly(),
);

export const configurationServiceWriteOptionsSchema = serviceDataBoundary(
  z
    .strictObject({
      layer: nonempty,
      ifRevision: nonempty.optional(),
    })
    .readonly(),
);

const strictErrorSchema = z.strictObject(weaverErrorSchema.shape).readonly();
export const configurationServiceWriteResultSchema = serviceDataBoundary(
  z
    .discriminatedUnion("success", [
      z
        .strictObject({
          success: z.literal(true),
          layer: nonempty,
          revision: nonempty,
        })
        .readonly(),
      z
        .strictObject({
          success: z.literal(false),
          error: strictErrorSchema,
          outcome: z.enum(["rejected", "unknown"]),
        })
        .readonly(),
    ])
    .refine(
      (result) =>
        result.success ||
        (result.outcome === "unknown") ===
          (result.error.code === "WRITE_OUTCOME_UNKNOWN"),
      { message: "Write outcome must agree with error code" },
    ),
);

/** Callable shape only: no invocation, argument proof, authorization or capability authenticity. */
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}

const readerShape = {
  identity: configurationServiceIdentitySchema,
  revision: nonempty,
  mode: z.enum(["live", "degraded"]),
  degradedProviders: z.array(nonempty).readonly(),
  get: callable<HydratedConfigurationReader["get"]>(),
  getWithDefault: callable<HydratedConfigurationReader["getWithDefault"]>(),
  getAtLayer: callable<HydratedConfigurationReader["getAtLayer"]>(),
  getNamespace: callable<HydratedConfigurationReader["getNamespace"]>(),
  inspect: callable<HydratedConfigurationReader["inspect"]>(),
  onChange: callable<HydratedConfigurationReader["onChange"]>(),
};
export const hydratedConfigurationReaderSchema = serviceDataBoundary(
  z.strictObject(readerShape),
);
export const hydratedConfigurationServiceSchema = serviceDataBoundary(
  z.strictObject({
    ...readerShape,
    getForScope: callable<HydratedConfigurationService["getForScope"]>(),
    preloadScope: callable<HydratedConfigurationService["preloadScope"]>(),
    set: callable<HydratedConfigurationService["set"]>(),
    remove: callable<HydratedConfigurationService["remove"]>(),
    reloadProvider: callable<HydratedConfigurationService["reloadProvider"]>(),
    flush: callable<HydratedConfigurationService["flush"]>(),
    dispose: callable<HydratedConfigurationService["dispose"]>(),
  }),
);

const scopedShape = {
  namespace: canonicalConfigurationPathSchema,
  identity: configurationServiceIdentitySchema,
  get: callable<HydratedScopedConfigurationService["get"]>(),
  getWithDefault:
    callable<HydratedScopedConfigurationService["getWithDefault"]>(),
  getAtLayer: callable<HydratedScopedConfigurationService["getAtLayer"]>(),
  getNamespace: callable<HydratedScopedConfigurationService["getNamespace"]>(),
  inspect: callable<HydratedScopedConfigurationService["inspect"]>(),
  onChange: callable<HydratedScopedConfigurationService["onChange"]>(),
  withScope: callable<HydratedScopedConfigurationService["withScope"]>(),
  dispose: callable<HydratedScopedConfigurationService["dispose"]>(),
};
export const hydratedScopedConfigurationServiceSchema = serviceDataBoundary(
  z.strictObject(scopedShape),
);
export const hydratedServiceConfigurationServiceSchema = serviceDataBoundary(
  z.strictObject({
    ...scopedShape,
    getFromNamespace:
      callable<HydratedServiceConfigurationService["getFromNamespace"]>(),
    pendingRestart: z.boolean(),
    onRestartRequired:
      callable<HydratedServiceConfigurationService["onRestartRequired"]>(),
    acknowledgeRestart:
      callable<HydratedServiceConfigurationService["acknowledgeRestart"]>(),
  }),
);
