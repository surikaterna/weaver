import { projectConfigurationData } from "@weaver-conf/config-engine";
import type {
  CanonicalConfigurationPath,
  HydratedConfigurationInspection,
} from "@weaver-conf/config-types";
import {
  type ConfigurationServiceIdentity,
  captureDomain,
  captureServiceData,
  domainSchema,
  hasDomainFields,
  isConfigurationServiceIdentity,
  isDomainRecord,
  ownDomainValue,
} from "@weaver-conf/config-types";
import type { z } from "zod";

interface ReadContextData {
  readonly identity: ConfigurationServiceIdentity;
  readonly revision: string;
}
function isReadContext(value: unknown): value is ReadContextData {
  return (
    isDomainRecord(value) &&
    hasDomainFields(value, ["identity", "revision"]) &&
    isConfigurationServiceIdentity(value.identity) &&
    typeof value.revision === "string" &&
    value.revision.length > 0
  );
}
export const registeredReadProjectionContextSchema = domainSchema<
  unknown,
  ReadContextData
>(
  (input) =>
    captureDomain(
      projectConfigurationData(
        input,
        {},
        { decide: () => "retain", child: (context) => context },
      ),
      isReadContext,
    ),
  "Invalid registered read context",
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
type ProjectionShape = {
  -readonly [K in keyof RegisteredReadProjection]: RegisteredReadProjection[K];
};
function isProjection(value: unknown): value is ProjectionShape {
  const methods = ["get", "getAtLayer", "getNamespace", "inspect", "entries"];
  return (
    isDomainRecord(value) &&
    hasDomainFields(value, methods) &&
    methods.every((key) => typeof ownDomainValue(value, key) === "function")
  );
}
export const registeredReadProjectionSchema = domainSchema<
  ProjectionShape,
  ProjectionShape
>((input) => {
  const captured = captureServiceData(input);
  return captured.success
    ? captureDomain(captured.value, isProjection)
    : captured;
}, "Invalid registered read callable shape");
