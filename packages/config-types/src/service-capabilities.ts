import type { z } from "zod";
import type { WeaverError } from "./errors";
import type { Result } from "./result";
import type {
  configurationInspectionValueSchema,
  configurationLayerContributionSchema,
  configurationReaderChangeOptionsSchema,
  configurationReaderChangeSchema,
  configurationRestartStateSchema,
  configurationServiceIdentitySchema,
  hydratedConfigurationInspectionSchema,
} from "./schemas-service-capabilities";

export type ConfigurationServiceIdentity = z.infer<
  typeof configurationServiceIdentitySchema
>;
export type ConfigurationInspectionValue = z.infer<
  typeof configurationInspectionValueSchema
>;
export type ConfigurationLayerContribution = z.infer<
  typeof configurationLayerContributionSchema
>;
export type HydratedConfigurationInspection = z.infer<
  typeof hydratedConfigurationInspectionSchema
>;
export type ConfigurationReaderChange = z.infer<
  typeof configurationReaderChangeSchema
>;
export type ConfigurationReaderChangeOptions = z.infer<
  typeof configurationReaderChangeOptionsSchema
>;
export type ConfigurationRestartState = z.infer<
  typeof configurationRestartStateSchema
>;

/** Host ownership conveys lifecycle control, never configuration read authority. */
export interface ConfigurationService {
  readonly mode: "live" | "degraded";
  readonly degradedProviders: readonly string[];
  readonly restartState: ConfigurationRestartState;
  acknowledgeRestart(
    expectedRevision: string,
  ): Promise<Result<undefined, WeaverError>>;
  reloadProvider(providerId: string): Promise<Result<undefined, WeaverError>>;
  flush(): Promise<Result<undefined, WeaverError>>;
  dispose(): Promise<Result<undefined, WeaverError>>;
}
