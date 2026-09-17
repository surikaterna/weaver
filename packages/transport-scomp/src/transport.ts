import type { IScompPeer } from "@scompr/core";
import type {
  ConfigDelta,
  ConfigSnapshot,
  ConfigurationPropertySchema,
  RegisteredEffectiveValidationResponse,
  SchemaRegistrationOptions,
  SchemaRegistrationRequest,
  SchemaRegistrationResponse,
  ScopeDefinition,
  ScopeInstance,
  WriteResult,
} from "@weaver-conf/config-types";
import { formatScopePath } from "@weaver-conf/config-types";
import { WeaverConfig, type WeaverConfigContract } from "./contract";
import { createSubscriptionFeedOwner } from "./subscription-feed";

// --- Transport types (defined locally to avoid depending on weaver-client) ---

/** Options for write operations — target layer, environment, and optimistic concurrency. */
export interface WriteOptions {
  layer?: string;
  environment?: string;
  ifRevision?: string;
}

export type { WriteResult };

/**
 * Transport interface for communicating with a Weaver configuration backend.
 * Matches the contract expected by @weaver-conf/weaver-client.
 */
export interface WeaverTransport {
  resolveAll(options?: {
    scopePath?: ScopeInstance[];
    namespace?: string;
  }): Promise<ConfigSnapshot>;
  get(key: string, options?: { scopePath?: ScopeInstance[] }): Promise<unknown>;
  getNamespace(
    prefix: string,
    options?: { scopePath?: ScopeInstance[] },
  ): Promise<Record<string, unknown>>;
  inspect(key: string): Promise<unknown>;
  subscribe(handler: (delta: ConfigDelta) => void): () => void;
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
  listScopes(): Promise<ScopeDefinition[]>;
  listScopeValues(
    scopeId: string,
    parentScope?: ScopeInstance[],
  ): Promise<string[]>;
  fetchSchemas?(): Promise<Record<string, ConfigurationPropertySchema>>;
  registerSchema?(
    request: SchemaRegistrationRequest,
    options?: SchemaRegistrationOptions,
  ): Promise<SchemaRegistrationResponse>;
  setRegisteredObject?(
    anchorPath: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  patchRegisteredPath?(
    path: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  validateRegisteredEffective?(options: {
    anchorPath: string;
    environment?: string;
    scopePath?: ScopeInstance[];
  }): Promise<RegisteredEffectiveValidationResponse>;
  close(): Promise<void>;
}

// --- Transport implementation ---

export interface ScompTransportOptions {
  peer: IScompPeer;
}

function buildScopeString(scopePath?: ScopeInstance[]): string | undefined {
  if (!scopePath?.length) return undefined;
  return formatScopePath(scopePath);
}

/** Creates a WeaverTransport backed by a SCOMP peer consuming the WeaverConfig contract. */
export function createScompTransport(
  options: ScompTransportOptions,
): WeaverTransport {
  const { peer } = options;
  const client = peer.consumes(WeaverConfig);
  const feeds = createSubscriptionFeedOwner(client, () => peer.close());

  return {
    ...readMethods(client),
    ...writeMethods(client),
    ...scopeMethods(client),
    ...registeredMethods(client),
    subscribe: feeds.subscribe,
    close: feeds.close,
  };
}

function readMethods(
  client: WeaverConfigContract,
): Pick<WeaverTransport, "resolveAll" | "get" | "getNamespace" | "inspect"> {
  return {
    async resolveAll(opts?) {
      const scope = buildScopeString(opts?.scopePath);
      return client.resolveAll({
        ...(scope != null && { scope }),
        ...(opts?.namespace != null && { namespace: opts.namespace }),
      });
    },

    async get(key, opts?) {
      const scope = buildScopeString(opts?.scopePath);
      const result = await client.get({
        key,
        ...(scope != null && { scope }),
      });
      return result.value;
    },

    async getNamespace(prefix, opts?) {
      const scope = buildScopeString(opts?.scopePath);
      const result = await client.getNamespace({
        prefix,
        ...(scope != null && { scope }),
      });
      return result.entries;
    },

    async inspect(key) {
      return client.inspect({ key });
    },
  };
}

function writeMethods(
  client: WeaverConfigContract,
): Pick<WeaverTransport, "set" | "setMany" | "remove"> {
  return {
    async set(key, value, opts?) {
      return client.set({
        key,
        value,
        ...(opts?.layer != null && { layer: opts.layer }),
        ...(opts?.environment != null && { environment: opts.environment }),
        ...(opts?.ifRevision != null && { ifRevision: opts.ifRevision }),
      });
    },

    async setMany(entries, opts?) {
      return client.setMany({
        entries,
        ...(opts?.layer != null && { layer: opts.layer }),
        ...(opts?.environment != null && { environment: opts.environment }),
        ...(opts?.ifRevision != null && { ifRevision: opts.ifRevision }),
      });
    },

    async remove(key, opts?) {
      return client.remove({
        key,
        ...(opts?.layer != null && { layer: opts.layer }),
        ...(opts?.environment != null && { environment: opts.environment }),
      });
    },
  };
}

function scopeMethods(
  client: WeaverConfigContract,
): Pick<
  WeaverTransport,
  "listScopes" | "listScopeValues" | "fetchSchemas" | "registerSchema"
> {
  return {
    async listScopes() {
      const result = await client.listScopes({});
      return result.scopes;
    },

    async listScopeValues(scopeId, parentScope?) {
      const result = await client.listScopeValues({
        scopeId,
        ...(parentScope != null && {
          parentScope: parentScope.map((s) => ({
            scopeId: s.scopeId,
            value: s.value,
          })),
        }),
      });
      return result.values;
    },

    async fetchSchemas() {
      const result = await client.fetchSchemas({});
      return result.schemas;
    },

    async registerSchema(request, options) {
      return client.registerSchema({
        ...request,
        ...(options?.ifRevision ? { ifRevision: options.ifRevision } : {}),
      });
    },
  };
}

function registeredMethods(
  client: WeaverConfigContract,
): Pick<
  WeaverTransport,
  "setRegisteredObject" | "patchRegisteredPath" | "validateRegisteredEffective"
> {
  return {
    async setRegisteredObject(anchorPath, value, opts?) {
      return client.setRegisteredObject({
        anchorPath,
        value,
        ...(opts?.layer != null && { layer: opts.layer }),
        ...(opts?.environment != null && { environment: opts.environment }),
        ...(opts?.ifRevision != null && { ifRevision: opts.ifRevision }),
      });
    },

    async patchRegisteredPath(path, value, opts?) {
      return client.patchRegisteredPath({
        path,
        value,
        ...(opts?.layer != null && { layer: opts.layer }),
        ...(opts?.environment != null && { environment: opts.environment }),
        ...(opts?.ifRevision != null && { ifRevision: opts.ifRevision }),
      });
    },

    async validateRegisteredEffective(options) {
      const scope = buildScopeString(options.scopePath);
      return client.validateRegisteredEffective({
        anchorPath: options.anchorPath,
        ...(options.environment != null && {
          environment: options.environment,
        }),
        ...(scope != null && { scope }),
      });
    },
  };
}
