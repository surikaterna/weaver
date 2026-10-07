import type { z } from "zod";
import type {
  configurationReaderGetOptionsSchema,
  configurationReaderSelectionSchema,
  configurationReaderSnapshotSchema,
} from "./schemas-service-readers";
import type {
  ConfigurationReaderChange,
  ConfigurationReaderChangeOptions,
  HydratedConfigurationInspection,
} from "./service-capabilities";
import type { ConfigurationValidationResponse } from "./service-mutations";
import type { RelativeConfigurationPath } from "./service-paths";
import type { ScopeInstance, Unsubscribe } from "./types";

export type ConfigurationReaderSelection = z.infer<
  typeof configurationReaderSelectionSchema
>;
export type ConfigurationReaderGetOptions = z.infer<
  typeof configurationReaderGetOptionsSchema
>;
export type ConfigurationReaderSnapshot = z.infer<
  typeof configurationReaderSnapshotSchema
>;

/** Issued authority stays private; selecting a scope or view never adds grants. */
export interface ConfigurationReader {
  readonly selection: ConfigurationReaderSelection;
  readonly revision: string;
  prepare(): Promise<void>;
  get(
    relativeSegments?: RelativeConfigurationPath,
    options?: ConfigurationReaderGetOptions,
  ): unknown;
  snapshot(
    relativeSegments?: RelativeConfigurationPath,
  ): ConfigurationReaderSnapshot;
  inspect(
    relativeSegments?: RelativeConfigurationPath,
  ): HydratedConfigurationInspection;
  validate(
    relativeSegments?: RelativeConfigurationPath,
  ): ConfigurationValidationResponse;
  withScope(scopePath: readonly ScopeInstance[]): ConfigurationReader;
  forView(viewId?: string): ConfigurationReader;
  onChange(
    relativeSegments: RelativeConfigurationPath,
    listener: (change: ConfigurationReaderChange) => void,
    options?: ConfigurationReaderChangeOptions,
  ): Unsubscribe;
  dispose(): void;
}
