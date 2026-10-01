import { projectConfigurationData } from "@weaver-conf/config-engine";
import type {
  CanonicalConfigurationPath,
  HydratedConfigurationInspection,
} from "@weaver-conf/config-types";
import { configurationServiceIdentitySchema } from "@weaver-conf/config-types";
import { z } from "zod";

export const registeredReadProjectionContextSchema = z.preprocess(
  (input) =>
    projectConfigurationData(
      input,
      {},
      { decide: () => "retain", child: (context) => context },
    ),
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

// Callable shape only: parsing never authenticates the reader or an issued snapshot.
export const registeredReadProjectionSchema = z.strictObject({
  get: z.custom<RegisteredReadProjection["get"]>(
    (value) => typeof value === "function",
  ),
  getAtLayer: z.custom<RegisteredReadProjection["getAtLayer"]>(
    (value) => typeof value === "function",
  ),
  getNamespace: z.custom<RegisteredReadProjection["getNamespace"]>(
    (value) => typeof value === "function",
  ),
  inspect: z.custom<RegisteredReadProjection["inspect"]>(
    (value) => typeof value === "function",
  ),
  entries: z.custom<RegisteredReadProjection["entries"]>(
    (value) => typeof value === "function",
  ),
});
