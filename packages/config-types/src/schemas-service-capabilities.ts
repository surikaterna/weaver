import { domainSchema } from "./domain-capture";
import type {
  ConfigurationEffectiveChange,
  ConfigurationInspectionValue,
  ConfigurationLayerContribution,
  ConfigurationServiceWriteOptions,
  ConfigurationServiceWriteResult,
  HydratedConfigurationInspection,
  HydratedConfigurationReader,
  HydratedConfigurationService,
  HydratedScopedConfigurationService,
  HydratedServiceConfigurationService,
} from "./service-capabilities";
import {
  type CapabilityShape,
  captureConfigurationServiceIdentity,
  captureServiceContract,
  isConfigurationEffectiveChange,
  isConfigurationInspectionValue,
  isConfigurationLayerContribution,
  isConfigurationServiceWriteOptions,
  isConfigurationServiceWriteResult,
  isHydratedCapability,
  isHydratedConfigurationInspection,
} from "./service-contract-captures";

export const configurationServiceIdentitySchema = domainSchema(
  captureConfigurationServiceIdentity,
  "Invalid configuration service identity",
);
export const configurationInspectionValueSchema = domainSchema<
  unknown,
  ConfigurationInspectionValue
>(
  (input) => captureServiceContract(input, isConfigurationInspectionValue),
  "Invalid configuration inspection value",
);
export const configurationLayerContributionSchema = domainSchema<
  unknown,
  ConfigurationLayerContribution
>(
  (input) => captureServiceContract(input, isConfigurationLayerContribution),
  "Invalid configuration layer contribution",
);
export const hydratedConfigurationInspectionSchema = domainSchema<
  unknown,
  HydratedConfigurationInspection
>(
  (input) => captureServiceContract(input, isHydratedConfigurationInspection),
  "Invalid hydrated configuration inspection",
);
export const configurationEffectiveChangeSchema = domainSchema<
  unknown,
  ConfigurationEffectiveChange
>(
  (input) => captureServiceContract(input, isConfigurationEffectiveChange),
  "Invalid configuration effective change",
);
export const configurationServiceWriteOptionsSchema = domainSchema<
  unknown,
  ConfigurationServiceWriteOptions
>(
  (input) => captureServiceContract(input, isConfigurationServiceWriteOptions),
  "Invalid configuration write options",
);
export const configurationServiceWriteResultSchema = domainSchema<
  unknown,
  ConfigurationServiceWriteResult
>(
  (input) => captureServiceContract(input, isConfigurationServiceWriteResult),
  "Invalid configuration write result",
);

function capabilitySchema<T>(
  kind: "reader" | "service" | "scoped" | "namespace",
) {
  // Each named public type has this same closed required-field/method predicate.
  const guard = (value: unknown): value is CapabilityShape<T> =>
    isHydratedCapability(value, kind);
  return domainSchema<unknown, CapabilityShape<T>>(
    (input) => captureServiceContract(input, guard),
    "Invalid hydrated capability shape",
  );
}
export const hydratedConfigurationReaderSchema =
  capabilitySchema<HydratedConfigurationReader>("reader");
export const hydratedConfigurationServiceSchema =
  capabilitySchema<HydratedConfigurationService>("service");
export const hydratedScopedConfigurationServiceSchema =
  capabilitySchema<HydratedScopedConfigurationService>("scoped");
export const hydratedServiceConfigurationServiceSchema =
  capabilitySchema<HydratedServiceConfigurationService>("namespace");
