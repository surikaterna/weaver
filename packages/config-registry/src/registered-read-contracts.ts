import { configurationSnapshotSchema } from "@weaver-conf/config-engine";
import {
  type ConfigurationNamespace,
  canonicalConfigurationPathSchema,
  captureServiceData,
  configurationPropertySchemaSchema,
  configurationServiceIdentitySchema,
  configurationViewIdSchema,
  type HydratedConfigurationInspection,
  isReservedPathSegment,
} from "@weaver-conf/config-types";
import { z } from "zod";

export const registeredReadProjectionContextSchema = z.preprocess(
  (input, context) => captureReadData(input, context),
  z
    .strictObject({
      identity: configurationServiceIdentitySchema,
      revision: z.string().min(1),
    })
    .readonly(),
);
export type RegisteredReadProjectionContext = z.infer<
  typeof registeredReadProjectionContextSchema
>;

export const registeredReadAccessEvidenceSchema = z
  .strictObject({
    path: z.array(z.string()).readonly(),
    schemas: z.array(configurationPropertySchemaSchema).readonly(),
    sensitive: z.boolean(),
    layer: z.string().optional(),
  })
  .readonly();
export type RegisteredReadAccessEvidence = z.infer<
  typeof registeredReadAccessEvidenceSchema
>;
export type RegisteredReadAccess = (
  evidence: RegisteredReadAccessEvidence,
) => boolean;
export const registeredReadAccessSchema = z.custom<RegisteredReadAccess>(
  (value) => typeof value === "function",
);

export const registeredReadViewSourceSchema = z
  .strictObject({
    snapshot: configurationSnapshotSchema,
    namespace: canonicalConfigurationPathSchema,
    viewId: configurationViewIdSchema,
  })
  .readonly();
export type RegisteredReadViewSource = z.infer<
  typeof registeredReadViewSourceSchema
>;

export interface RegisteredReadProjection {
  readonly authorizeValidation: (
    path: ConfigurationNamespace,
    access?: RegisteredReadAccess,
  ) => void;
  readonly get: (
    path: ConfigurationNamespace,
    access?: RegisteredReadAccess,
  ) => unknown;
  readonly getAtLayer: (
    layer: string,
    path: ConfigurationNamespace,
    access?: RegisteredReadAccess,
  ) => unknown;
  readonly getNamespace: (
    prefix: ConfigurationNamespace,
    access?: RegisteredReadAccess,
  ) => Readonly<Record<string, unknown>>;
  readonly inspect: (
    path: ConfigurationNamespace,
    access?: RegisteredReadAccess,
  ) => HydratedConfigurationInspection;
  readonly entries: (
    access?: RegisteredReadAccess,
  ) => Readonly<Record<string, unknown>>;
}

// Callable shape only: parsing does not authenticate a reader or an issued snapshot.
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}
type ProjectionShape = {
  -readonly [K in keyof RegisteredReadProjection]: RegisteredReadProjection[K];
};
export const registeredReadProjectionSchema = z
  .custom<ProjectionShape>(admitProjection)
  .pipe(
    z.strictObject({
      authorizeValidation:
        callable<RegisteredReadProjection["authorizeValidation"]>(),
      get: callable<RegisteredReadProjection["get"]>(),
      getAtLayer: callable<RegisteredReadProjection["getAtLayer"]>(),
      getNamespace: callable<RegisteredReadProjection["getNamespace"]>(),
      inspect: callable<RegisteredReadProjection["inspect"]>(),
      entries: callable<RegisteredReadProjection["entries"]>(),
    }),
  );

function admitProjection(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) return false;
    return Reflect.ownKeys(input).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return (
        typeof key === "string" &&
        !isReservedPathSegment(key) &&
        descriptor !== undefined &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable === true
      );
    });
  } catch {
    return false;
  }
}

function captureReadData(input: unknown, context: z.RefinementCtx): unknown {
  const captured = captureServiceData(input);
  if (captured.success) return captured.value;
  context.addIssue({ code: "custom", message: "Invalid registered read data" });
  return z.NEVER;
}
