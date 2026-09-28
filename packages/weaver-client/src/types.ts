import type { ScopeInstance } from "@weaver-conf/config-types";

export type {
  ConfigDelta,
  ConfigSnapshot,
  ConfigurationInspection,
  Unsubscribe,
} from "@weaver-conf/config-types";

/** Options for resolving configuration (optional scope path and environment). */
export interface ResolveOptions {
  scopePath?: ScopeInstance[];
  environment?: string;
}

/** Options for getting a single key (optional scope path). */
export interface GetOptions {
  scopePath?: ScopeInstance[];
}

/**
 * Client-specific layer inspection that includes per-layer metadata (environment binding).
 * Differs from the canonical `ConfigurationInspection<T>` in config-types which uses a flat
 * `layerValues: Partial<Record<string, T>>` map. This richer structure is needed on the client
 * to display layer provenance with environment context in UI tooling.
 */
export interface ClientLayerInspection<T> {
  key: string;
  effectiveValue: T | undefined;
  layers: Array<{ layer: string; value: T | undefined; environment?: string }>;
}

/** Current operational mode of the client (live, cached, or degraded). */
export type ClientMode = "live" | "cached" | "degraded";

/** Options for enabling schema validation on the client. */
export interface SchemaOptions {
  /** Schema registration environment to load (default: "default") */
  environment?: string;
  /** Subscribe to schema changes from server (default: true) */
  live?: boolean;
  /** Log warnings when values don't match server schema (default: true) */
  warnOnMismatch?: boolean;
}
