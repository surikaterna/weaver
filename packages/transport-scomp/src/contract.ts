import { createContractToken } from "@scompr/core";
import type {
  ConfigDelta,
  ConfigSnapshot,
  ConfigurationInspection,
  ConfigurationPropertySchema,
  SchemaRegistrationRequest,
  SchemaRegistrationResponse,
  ScopeDefinition,
  WriteResult,
} from "@weaver-conf/config-types";

// Re-export config-types used in contract signatures
export type { ConfigDelta, ConfigSnapshot };

// --- Contract method input types ---

export interface ResolveAllInput {
  scope?: string;
  namespace?: string;
}

export interface GetInput {
  key: string;
  scope?: string;
}

export interface GetNamespaceInput {
  prefix: string;
  scope?: string;
}

export interface InspectInput {
  key: string;
}

export interface SetInput {
  key: string;
  value: unknown;
  layer?: string;
  environment?: string;
  ifRevision?: string;
  scope?: string;
}

export interface SetManyInput {
  entries: Record<string, unknown>;
  layer?: string;
  environment?: string;
  ifRevision?: string;
  scope?: string;
}

export interface RemoveInput {
  key: string;
  layer?: string;
  environment?: string;
  scope?: string;
}

export interface ListScopeValuesInput {
  scopeId: string;
  parentScope?: Array<{ scopeId: string; value: string }>;
}

export type EmptyInput = Record<PropertyKey, never>;

export type FetchSchemasInput = EmptyInput;

export type RegisterSchemaInput = SchemaRegistrationRequest;

export interface SubscribeInput {
  namespace?: string;
  scope?: string;
}

// --- The contract ---

export interface WeaverConfigContract {
  // Requests (return Promise<T>)
  resolveAll(input: ResolveAllInput): Promise<ConfigSnapshot>;
  get(input: GetInput): Promise<{ value: unknown }>;
  getNamespace(
    input: GetNamespaceInput,
  ): Promise<{ entries: Record<string, unknown> }>;
  inspect(input: InspectInput): Promise<ConfigurationInspection<unknown>>;
  set(input: SetInput): Promise<WriteResult>;
  setMany(input: SetManyInput): Promise<WriteResult>;
  remove(input: RemoveInput): Promise<WriteResult>;
  listScopes(input: EmptyInput): Promise<{ scopes: ScopeDefinition[] }>;
  listScopeValues(input: ListScopeValuesInput): Promise<{ values: string[] }>;
  fetchSchemas(
    input: FetchSchemasInput,
  ): Promise<{ schemas: Record<string, ConfigurationPropertySchema> }>;
  registerSchema(
    input: RegisterSchemaInput,
  ): Promise<SchemaRegistrationResponse>;

  // Feed (returns AsyncIterable<T>)
  subscribe(input: SubscribeInput): AsyncIterable<ConfigDelta>;
}

/** Contract token for the Weaver configuration service. Shared between client and server peers. */
export const WeaverConfig =
  createContractToken<WeaverConfigContract>("weaver-config-v1");
