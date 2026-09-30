import type { ZodType } from "zod";
import type {
  OverrideSession,
  SessionActivationRequest,
  SessionDeactivationResult,
} from "./session";
import type { ConfigurationLayer, ScopeInstance } from "./types";

/**
 * Minimal handle for session lifecycle — satisfied by OverrideSessionController
 * without creating a dependency from config-types to config-sessions.
 */
export interface ConfigurationSessionHandle {
  activate(request: SessionActivationRequest): OverrideSession;
  deactivate(): SessionDeactivationResult;
  extend(durationMs?: number | undefined): OverrideSession;
  getSession(): OverrideSession | null;
  isActive(): boolean;
}

/** @deprecated Use HydratedConfigurationInspection for coherent redaction-aware snapshots. */
export interface ConfigurationInspection<T> {
  key: string;
  effectiveValue: T | undefined;
  effectiveLayer: ConfigurationLayer | string | undefined;
  layerValues: Partial<Record<string, T>>;
  /** Mount chain if key resolves through mount indirection */
  mountChain?: readonly string[] | undefined;
  /** Whether the effective value was resolved from a SecretReference */
  secretResolved?: boolean | undefined;
}

/** @deprecated Use HydratedConfigurationService; legacy Zod reads/void writes remain unchanged. */
export interface ConfigurationService {
  get<T>(key: string): T | undefined;
  get<T>(key: string, schema: ZodType<T>): T | undefined;
  getWithDefault<T>(key: string, defaultValue: T): T;
  getAtLayer<T>(layer: ConfigurationLayer | string, key: string): T | undefined;
  getForScope<T>(key: string, scopePath: ScopeInstance[]): T | undefined;
  inspect<T>(key: string): ConfigurationInspection<T>;
  set(key: string, value: unknown, layer?: ConfigurationLayer): Promise<void>;
  remove(key: string, layer: ConfigurationLayer): void;
  onChange(key: string, listener: (value: unknown) => void): () => void;
  getNamespace(prefix: string): Record<string, unknown>;
  readonly session?: ConfigurationSessionHandle | undefined;
}

/** @deprecated Use HydratedScopedConfigurationService without writable root exposure. */
export interface ScopedConfigurationService {
  get<T>(relativeKey: string): T | undefined;
  getWithDefault<T>(relativeKey: string, defaultValue: T): T;
  getForScope<T>(
    relativeKey: string,
    scopePath: ScopeInstance[],
  ): T | undefined;
  withScope(scopePath: ScopeInstance[]): ScopedConfigurationService;
  forView(viewId: string): ViewConfigurationService;
  inspect<T>(relativeKey: string): ConfigurationInspection<T>;
  onChange(relativeKey: string, listener: (value: unknown) => void): () => void;
  readonly root: ConfigurationService;
}

/** @deprecated View grants and executable replacement are deferred pending trusted authority. */
export interface ViewConfigurationService {
  get<T>(key: string): T | undefined;
  getWithDefault<T>(key: string, defaultValue: T): T;
  getForInstance<T>(instanceId: string, key: string): T | undefined;
  setForInstance(
    instanceId: string,
    key: string,
    value: unknown,
  ): Promise<void>;
  resetInstance(instanceId: string): void;
}

/** @deprecated Use HydratedServiceConfigurationService for confined synchronous reads. */
export interface ServiceConfigurationService {
  get<T>(key: string): T | undefined;
  getWithDefault<T>(key: string, defaultValue: T): T;
  getFromNamespace<T>(namespace: string, key: string): T | undefined;
  onChange(key: string, listener: (value: unknown) => void): () => void;
  readonly pendingRestart: boolean;
  onRestartRequired(listener: () => void): () => void;
}
