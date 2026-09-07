// Types and interfaces for WeaverConfigService

import type {
  SchemaValidationResult,
  WeaverLogger,
} from "@weaver-conf/config-engine";
import type { SecretBackend } from "@weaver-conf/config-runtime";
import type {
  ConfigurationInspection,
  ConfigurationStorageProvider,
  ScopeInstance,
  Unsubscribe,
  WriteResult,
} from "@weaver-conf/config-types";
import type { ConfigDelta, ConfigSnapshot } from "../types/index";
import type { SchemaRegistry } from "./schema-registry";

export type { Unsubscribe } from "@weaver-conf/config-types";

export interface WriteContext {
  environment?: string;
  scopePath?: ScopeInstance[];
  actor?: string;
  expectedRevision?: string;
}

export interface SchemaWriteContext extends WriteContext {
  schemaRegistry: SchemaRegistry;
}

export interface EffectiveValidationContext {
  schemaRegistry: SchemaRegistry;
  environment?: string;
  scopePath?: ScopeInstance[];
}

export interface WeaverConfigServiceOptions {
  providers: ConfigurationStorageProvider[];
  environment: string;
  logger?: WeaverLogger;
  flushDebounceMs?: number;
  /** Optional secret backend for resolving SecretReference markers. */
  secretBackend?: SecretBackend;
}

export interface WeaverConfigService {
  resolveAll(options?: {
    scopePath?: ScopeInstance[];
  }): Promise<ConfigSnapshot>;
  get(key: string, options?: { scopePath?: ScopeInstance[] }): Promise<unknown>;
  getNamespace(
    prefix: string,
    options?: { scopePath?: ScopeInstance[] },
  ): Promise<Record<string, unknown>>;
  inspect(key: string): Promise<ConfigurationInspection<unknown>>;
  readonly providers: ReadonlyArray<ConfigurationStorageProvider>;
  readonly degradedProviders: ReadonlyArray<string>;
  readonly revision: string;
  reloadProvider(providerId: string): Promise<void>;
  set(
    layer: string,
    key: string,
    value: unknown,
    options?: WriteContext,
  ): Promise<WriteResult>;
  remove(
    layer: string,
    key: string,
    options?: WriteContext,
  ): Promise<WriteResult>;
  onDelta(handler: (delta: ConfigDelta) => void): Unsubscribe;
  /** Group multiple writes into one commit. Auto-flushes at the end. */
  batch<T>(fn: () => Promise<T>): Promise<T>;
  /** Write multiple key-value pairs in a single batch. */
  setMany(
    layer: string,
    entries: Record<string, unknown>,
    options?: WriteContext,
  ): Promise<WriteResult>;
  setRegisteredObject(
    layer: string,
    path: string,
    value: unknown,
    options: SchemaWriteContext,
  ): Promise<WriteResult>;
  patchRegisteredPath(
    layer: string,
    path: string,
    value: unknown,
    options: SchemaWriteContext,
  ): Promise<WriteResult>;
  validateRegisteredEffective(
    path: string,
    options: EffectiveValidationContext,
  ): Promise<SchemaValidationResult>;
  /** Flush all dirty providers. Rarely needed — set/remove auto-flush. */
  flush(): Promise<void>;
  /** Refresh all providers from remote sources, then reload state. */
  refreshProviders(): Promise<void>;
}
