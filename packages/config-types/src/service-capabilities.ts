import type { z } from "zod";
import type { WeaverError } from "./errors";
import type { Result } from "./result";
import type {
  configurationEffectiveChangeSchema,
  configurationInspectionValueSchema,
  configurationLayerContributionSchema,
  configurationServiceIdentitySchema,
  configurationServiceWriteOptionsSchema,
  configurationServiceWriteResultSchema,
  hydratedConfigurationInspectionSchema,
} from "./schemas-service-capabilities";
import type {
  CanonicalConfigurationPath,
  RelativeConfigurationPath,
} from "./service-paths";
import type { ScopeInstance, Unsubscribe } from "./types";

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
export type ConfigurationEffectiveChange = z.infer<
  typeof configurationEffectiveChangeSchema
>;
export type ConfigurationServiceWriteOptions = z.infer<
  typeof configurationServiceWriteOptionsSchema
>;
export type ConfigurationServiceWriteResult = z.infer<
  typeof configurationServiceWriteResultSchema
>;

/** Synchronous coherent snapshots; cold/disposed reads throw SCOPE_NOT_LOADED/DISPOSED. */
export interface HydratedConfigurationReader {
  readonly identity: ConfigurationServiceIdentity;
  readonly revision: string;
  readonly mode: "live" | "degraded";
  readonly degradedProviders: readonly string[];
  get(path: CanonicalConfigurationPath): unknown;
  getWithDefault(
    path: CanonicalConfigurationPath,
    defaultValue: unknown,
  ): unknown;
  getAtLayer(layer: string, path: CanonicalConfigurationPath): unknown;
  getNamespace(
    prefix: CanonicalConfigurationPath,
  ): Readonly<Record<string, unknown>>;
  inspect(path: CanonicalConfigurationPath): HydratedConfigurationInspection;
  onChange(
    path: CanonicalConfigurationPath,
    listener: (change: ConfigurationEffectiveChange) => void,
  ): Unsubscribe;
}

/** Root ownership is not authentication; unavailable write authority returns WRITE_UNAVAILABLE. */
export interface HydratedConfigurationService
  extends HydratedConfigurationReader {
  getForScope(
    path: CanonicalConfigurationPath,
    scopePath: readonly ScopeInstance[],
  ): unknown;
  preloadScope(scopePath: readonly ScopeInstance[]): Promise<void>;
  set(
    path: CanonicalConfigurationPath,
    value: unknown,
    options: ConfigurationServiceWriteOptions,
  ): Promise<ConfigurationServiceWriteResult>;
  remove(
    path: CanonicalConfigurationPath,
    options: ConfigurationServiceWriteOptions,
  ): Promise<ConfigurationServiceWriteResult>;
  reloadProvider(providerId: string): Promise<Result<undefined, WeaverError>>;
  flush(): Promise<Result<undefined, WeaverError>>;
  dispose(): Promise<Result<undefined, WeaverError>>;
}

/** Confined read handle; disposal releases only this handle's subscriptions. */
export interface HydratedScopedConfigurationService {
  readonly namespace: CanonicalConfigurationPath;
  readonly identity: ConfigurationServiceIdentity;
  get(relative: RelativeConfigurationPath): unknown;
  getWithDefault(
    relative: RelativeConfigurationPath,
    defaultValue: unknown,
  ): unknown;
  getAtLayer(layer: string, relative: RelativeConfigurationPath): unknown;
  getNamespace(
    relative: RelativeConfigurationPath,
  ): Readonly<Record<string, unknown>>;
  inspect(relative: RelativeConfigurationPath): HydratedConfigurationInspection;
  onChange(
    relative: RelativeConfigurationPath,
    listener: (change: ConfigurationEffectiveChange) => void,
  ): Unsubscribe;
  /** Replaces the entire captured path, without I/O; rejects a cold identity. */
  withScope(
    scopePath: readonly ScopeInstance[],
  ): HydratedScopedConfigurationService;
  dispose(): void;
}

export interface HydratedServiceConfigurationService
  extends HydratedScopedConfigurationService {
  /** Cross-namespace access requires policy permission; denial throws FORBIDDEN. */
  getFromNamespace(
    namespace: CanonicalConfigurationPath,
    relative: RelativeConfigurationPath,
  ): unknown;
  readonly pendingRestart: boolean;
  onRestartRequired(listener: () => void): Unsubscribe;
  acknowledgeRestart(): void;
}
