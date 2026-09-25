import type {
  ConfigurationPropertySchema,
  SchemaRegistrationRequest,
  SchemaRegistrationResponse,
  ScopeDefinition,
  ScopeInstance,
  WriteResult,
} from "@weaver-conf/config-types";
import type {
  ConfigDelta,
  ConfigSnapshot,
  GetOptions,
  ResolveOptions,
  Unsubscribe,
} from "./types";

/** Options for write operations — target layer, environment, and optimistic concurrency. */
export interface WriteOptions {
  layer?: string;
  environment?: string;
  ifRevision?: string;
}

export type { WriteResult };

/**
 * Transport interface for communicating with a Weaver configuration backend.
 * Implementations handle reads, writes, subscriptions, scopes, and schema operations.
 */
export interface WeaverTransport {
  // Reads
  resolveAll(options?: ResolveOptions): Promise<ConfigSnapshot>;
  get(key: string, options?: GetOptions): Promise<unknown>;
  getNamespace(
    prefix: string,
    options?: GetOptions,
  ): Promise<Record<string, unknown>>;
  inspect(key: string): Promise<unknown>;
  subscribe(handler: (delta: ConfigDelta) => void): Unsubscribe;

  // Writes
  set(
    key: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  setMany(
    entries: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  remove(key: string, options?: WriteOptions): Promise<WriteResult>;

  // Scopes
  listScopes(): Promise<ScopeDefinition[]>;
  listScopeValues(
    scopeId: string,
    parentScope?: ScopeInstance[],
  ): Promise<string[]>;

  // Schemas
  fetchSchemas?(): Promise<Record<string, ConfigurationPropertySchema>>;
  registerSchema?(
    request: SchemaRegistrationRequest,
  ): Promise<SchemaRegistrationResponse>;

  // Lifecycle
  close(): Promise<void>;
}
