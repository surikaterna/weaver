// Environment-aware storage provider types and provenance tracking

import { z } from "zod";

/** Identifies a deployment environment */
export const environmentNamePattern =
  /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const environmentNameSchema = z
  .string()
  .regex(
    environmentNamePattern,
    "Environment must be a safe identifier containing only letters, numbers, dots, underscores, and hyphens",
  );

export type EnvironmentName = z.infer<typeof environmentNameSchema>;

/** Source tracking for a config value */
export interface ConfigValueSource {
  /** The layer that provided this value */
  readonly layer: string;
  /** The environment ("base" or env name) within the layer */
  readonly environment: EnvironmentName;
  /** Whether this value came from the env overlay (true) or base (false) */
  readonly isOverlay: boolean;
}

/** Result of merging base + environment overlay for a single layer */
export interface MergedLayerResult {
  /** The merged entries (base deep-merged with env overlay) */
  readonly entries: Record<string, unknown>;
  /** Per-key source tracking: which keys came from base vs overlay */
  readonly sources: ReadonlyMap<string, ConfigValueSource>;
}

/** Storage provider that supports environment-aware loading */
export interface EnvironmentAwareStorageProvider {
  /** Load entries for a specific environment. "base" loads the base entries. */
  loadForEnvironment(
    environment: EnvironmentName,
  ): Promise<{ entries: Record<string, unknown> }>;
  /** List available environments for this provider */
  listEnvironments(): Promise<readonly EnvironmentName[]>;
}

/** Detail about a value in a specific layer for provenance inspection */
export interface LayerValueDetail<T = unknown> {
  readonly value: T;
  readonly source: ConfigValueSource;
}
