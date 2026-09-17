import type { IScompPeer } from "@scompr/core";
import type {
  ConfigDelta,
  ConfigSnapshot,
  ConfigurationPropertySchema,
  SchemaRegistrationRequest,
  SchemaRegistrationResponse,
  ScopeDefinition,
  ScopeInstance,
  WriteResult,
} from "@weaver-conf/config-types";
import { formatScopePath } from "@weaver-conf/config-types";
import { WeaverConfig } from "./contract";

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
  ): Promise<SchemaRegistrationResponse>;
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

  const activeFeeds: Array<{ abort: () => void }> = [];

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

    subscribe(handler) {
      const feed = client.subscribe({});
      let aborted = false;

      const consume = async () => {
        try {
          for await (const delta of feed) {
            if (aborted) break;
            handler(delta);
          }
        } catch {
          // Feed closed or error — silently stop
        }
      };

      consume();

      const feedState = {
        abort: () => {
          aborted = true;
        },
      };
      activeFeeds.push(feedState);

      return () => {
        feedState.abort();
        const idx = activeFeeds.indexOf(feedState);
        if (idx >= 0) activeFeeds.splice(idx, 1);
      };
    },

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

    async registerSchema(request) {
      return client.registerSchema(request);
    },

    async close() {
      for (const feed of activeFeeds) feed.abort();
      activeFeeds.length = 0;
    },
  };
}
