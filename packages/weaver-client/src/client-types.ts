import type {
  RegisteredEffectiveValidationResponse,
  SchemaRegistrationRequest,
  SchemaRegistrationResponse,
  ScopeDefinition,
  ScopeInstance,
} from "@weaver-conf/config-types";
import type { ZodRawShape } from "zod";
import type {
  InstanceClient,
  NamespaceDefinition,
  TypedNamespaceClient,
  UntypedNamespaceClient,
} from "./namespace";
import type { WeaverClientPersistence } from "./persistence";
import type { ValidationResult } from "./schema-registry";
import type { ScopeLoadingMode } from "./scope-manager";
import type { StalenessConfig } from "./staleness";
import type {
  EffectiveValidationOptions,
  WeaverTransport,
  WriteOptions,
  WriteResult,
} from "./transport";
import type {
  ClientMode,
  ConfigDelta,
  ConfigurationInspection,
  SchemaOptions,
  Unsubscribe,
} from "./types";

/** Configuration options for creating a WeaverClient instance. */
export interface WeaverClientOptions {
  namespace?: string;
  transport: WeaverTransport;
  scopeLoading?: ScopeLoadingMode;
  persistence?: WeaverClientPersistence;
  /** If true and transport fails, boot from cache in degraded mode (default: true if persistence provided) */
  offlineBoot?: boolean;
  /** Staleness detection configuration */
  staleness?: StalenessConfig;
  /** Enable server-schema validation on get/set */
  schemas?: boolean | SchemaOptions;
}

/**
 * Main client interface for reading, writing, and subscribing to Weaver configuration.
 * All reads are synchronous (from local state); writes are async via the transport.
 */
export interface WeaverClient {
  // ── Reads (sync, from local state) ──
  get<T>(key: string): T | undefined;
  get<T>(key: string, scopePath: ScopeInstance[]): T | undefined;
  getWithDefault<T>(key: string, defaultValue: T): T;
  getWithDefault<T>(
    key: string,
    defaultValue: T,
    scopePath: ScopeInstance[],
  ): T;
  getNamespace(prefix: string): Record<string, unknown>;
  getNamespace(
    prefix: string,
    scopePath: ScopeInstance[],
  ): Record<string, unknown>;
  getForScope<T>(key: string, scopePath: ScopeInstance[]): T | undefined;

  // ── Inspection (async, server round-trip) ──
  inspect<T>(key: string): Promise<ConfigurationInspection<T>>;

  // ── Writes (async, goes to server) ──
  set(
    key: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  setMany(
    entries: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  setNamespace(
    prefix: string,
    values: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  remove(key: string, options?: WriteOptions): Promise<WriteResult>;
  setRegisteredObject(
    anchorPath: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  patchRegisteredPath(
    path: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;

  // ── Scopes ──
  listScopes(): Promise<ScopeDefinition[]>;
  listScopeValues(
    scopeId: string,
    parentScope?: ScopeInstance[],
  ): Promise<string[]>;
  preloadScope(scopePath: ScopeInstance[]): Promise<void>;

  // ── Change tracking ──
  onChange(
    pattern: string,
    handler: (changes: ConfigDelta[]) => void,
  ): Unsubscribe;
  onRestartRequired(handler: () => void): Unsubscribe;
  readonly pendingRestart: boolean;

  // ── Health ──
  readonly mode: ClientMode;
  readonly revision: string;
  readonly connected: boolean;
  readonly lastSyncedAt: Date | null;
  readonly staleSince: Date | null;

  // ── Validation ──
  validate(key: string, value: unknown): ValidationResult;
  validateRegisteredEffective(
    options: EffectiveValidationOptions,
  ): Promise<RegisteredEffectiveValidationResponse>;
  isSensitive(key: string): boolean;

  // ── Namespaces ──
  namespace<TShape extends ZodRawShape>(
    definition: NamespaceDefinition<string, TShape>,
  ): TypedNamespaceClient<TShape>;
  namespace(prefix: string): UntypedNamespaceClient;

  // ── Registration ──
  registerSchema(
    request: SchemaRegistrationRequest,
  ): Promise<SchemaRegistrationResponse>;

  // ── Instances ──
  instance(basePath: string, instanceId: string): InstanceClient;

  // ── Lifecycle ──
  close(): Promise<void>;
}
