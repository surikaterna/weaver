import {
  type CanonicalConfigurationPath,
  captureServiceData,
  configurationServiceIdentitySchema,
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

export interface RegisteredReadProjection {
  readonly get: (path: CanonicalConfigurationPath) => unknown;
  readonly getAtLayer: (
    layer: string,
    path: CanonicalConfigurationPath,
  ) => unknown;
  readonly getNamespace: (
    prefix: CanonicalConfigurationPath,
  ) => Readonly<Record<string, unknown>>;
  readonly inspect: (
    path: CanonicalConfigurationPath,
  ) => HydratedConfigurationInspection;
  readonly entries: () => Readonly<Record<string, unknown>>;
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
