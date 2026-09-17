import { deepGet } from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import type { ZodRawShape } from "zod";
import { applyNamespace } from "./client-helpers";
import { type ClientState, createClientState } from "./client-state";
import type { WeaverClient, WeaverClientOptions } from "./client-types";
import {
  unsupportedRegistration,
  unsupportedValidation,
  unsupportedWrite,
} from "./client-unsupported";
import { createInstanceClient } from "./instance-client";
import type {
  NamespaceDefinition,
  TypedNamespaceClient,
  UntypedNamespaceClient,
} from "./namespace";
import type { ValidationResult } from "./schema-registry";
import type { WriteOptions, WriteResult } from "./transport";
import { createTypedNamespaceClient } from "./typed-namespace-client";
import type { ConfigDelta, Unsubscribe } from "./types";
import { createUntypedNamespaceClient } from "./untyped-namespace-client";
import { validateOnRead, validateOnWrite } from "./validation";

export type { WeaverClient, WeaverClientOptions } from "./client-types";

export async function createWeaverClient(
  options: WeaverClientOptions,
): Promise<WeaverClient> {
  const state = await createClientState(options);
  const client: WeaverClient = {
    ...readMethods(state, () => client),
    ...namespaceReadMethods(state),
    ...writeMethods(state),
    ...batchMethods(state),
    ...registeredMethods(state),
    ...listenerMethods(state),
    ...statusMethods(state),
    ...validationMethods(state),
    namespace: namespaceFactory(state, () => client),
    instance: (basePath, instanceId) =>
      instanceClient(state, client, basePath, instanceId),
  };
  return Object.defineProperties(
    client,
    Object.getOwnPropertyDescriptors(statusMethods(state)),
  );
}

function namespaceFactory(state: ClientState, getClient: () => WeaverClient) {
  const { namespace, transport, scopeLoader, baseState } = state;

  function namespaceClient<TShape extends ZodRawShape>(
    definition: NamespaceDefinition<string, TShape>,
  ): TypedNamespaceClient<TShape>;
  function namespaceClient(prefix: string): UntypedNamespaceClient;
  function namespaceClient(
    defOrPrefix: NamespaceDefinition | string,
  ): TypedNamespaceClient<ZodRawShape> | UntypedNamespaceClient {
    if (typeof defOrPrefix === "string") {
      const resolvedPrefix = applyNamespace(namespace, defOrPrefix);
      return createUntypedNamespaceClient(resolvedPrefix, {
        getState: (sp) =>
          sp ? (scopeLoader.getScopeState(sp) ?? {}) : baseState,
        set: (key, value, opts) => transport.set(key, value, opts),
        setMany: (entries, opts) => transport.setMany(entries, opts),
        remove: (key, opts) => transport.remove(key, opts),
        onChange: (pattern, handler) => getClient().onChange(pattern, handler),
      });
    }

    return createTypedNamespaceClient(defOrPrefix, {
      getState: (sp) =>
        sp ? (scopeLoader.getScopeState(sp) ?? {}) : baseState,
      set: (key, value, opts) => transport.set(key, value, opts),
      remove: (key, opts) => transport.remove(key, opts),
      onChange: (pattern, handler) => getClient().onChange(pattern, handler),
    });
  }

  return namespaceClient;
}

function readMethods(
  state: ClientState,
  getClient: () => WeaverClient,
): Pick<WeaverClient, "get" | "getWithDefault" | "getForScope"> {
  const { namespace, scopeLoader, baseState, registry, validationOptions } =
    state;
  return {
    get<T>(key: string, scopePath?: ScopeInstance[]): T | undefined {
      const resolvedKey = applyNamespace(namespace, key);
      let value: T | undefined;
      if (scopePath) {
        const scopeState = scopeLoader.getScopeState(scopePath);
        if (!scopeState) return undefined;
        // SAFETY: deepGet returns the stored value which was set with correct type
        value = deepGet(scopeState, resolvedKey) as T | undefined;
      } else {
        // SAFETY: deepGet returns the stored value which was set with correct type
        value = deepGet(baseState, resolvedKey) as T | undefined;
      }
      // SAFETY: validateOnRead preserves the type or returns undefined
      return validateOnRead(resolvedKey, value, registry, validationOptions) as
        | T
        | undefined;
    },

    getWithDefault<T>(
      key: string,
      defaultValue: T,
      scopePath?: ScopeInstance[],
    ): T {
      const value = scopePath
        ? getClient().get<T>(key, scopePath)
        : getClient().get<T>(key);
      return value !== undefined ? value : defaultValue;
    },

    getForScope<T>(key: string, scopePath: ScopeInstance[]): T | undefined {
      return getClient().get<T>(key, scopePath);
    },
  };
}

function namespaceReadMethods({
  namespace,
  scopeLoader,
  baseState,
  transport,
}: ClientState): Pick<WeaverClient, "getNamespace" | "inspect"> {
  return {
    getNamespace(
      prefix: string,
      scopePath?: ScopeInstance[],
    ): Record<string, unknown> {
      const resolvedPrefix = applyNamespace(namespace, prefix);
      const source = scopePath
        ? (scopeLoader.getScopeState(scopePath) ?? {})
        : baseState;
      const value = deepGet(source, resolvedPrefix);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return value as Record<string, unknown>; // SAFETY: guarded by typeof/null/array checks
      }
      return {};
    },

    async inspect<T>(
      key: string,
    ): Promise<import("./types.js").ConfigurationInspection<T>> {
      const resolvedKey = applyNamespace(namespace, key);
      const raw = await transport.inspect(resolvedKey);
      // SAFETY: transport.inspect returns the inspection structure matching ConfigurationInspection<T>
      return raw as import("./types.js").ConfigurationInspection<T>;
    },
  };
}

function writeMethods({
  namespace,
  registry,
  transport,
}: ClientState): Pick<WeaverClient, "set" | "remove"> {
  return {
    async set(
      key: string,
      value: unknown,
      opts?: WriteOptions,
    ): Promise<WriteResult> {
      const resolvedKey = applyNamespace(namespace, key);
      const result = validateOnWrite(resolvedKey, value, registry);
      if (!result.valid) {
        const message =
          result.errors?.map((e) => e.message).join(", ") ??
          "Validation failed";
        return {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message,
            details: { errors: result.errors },
          },
        };
      }
      return transport.set(resolvedKey, value, opts);
    },

    async remove(key: string, opts?: WriteOptions): Promise<WriteResult> {
      const resolvedKey = applyNamespace(namespace, key);
      return transport.remove(resolvedKey, opts);
    },
  };
}

function registeredMethods({
  transport,
}: ClientState): Pick<
  WeaverClient,
  | "setRegisteredObject"
  | "patchRegisteredPath"
  | "validateRegisteredEffective"
  | "registerSchema"
> {
  return {
    async setRegisteredObject(anchorPath, value, opts) {
      if (!transport.setRegisteredObject)
        return unsupportedWrite("setRegisteredObject");
      return transport.setRegisteredObject(anchorPath, value, opts);
    },

    async patchRegisteredPath(path, value, opts) {
      if (!transport.patchRegisteredPath)
        return unsupportedWrite("patchRegisteredPath");
      return transport.patchRegisteredPath(path, value, opts);
    },

    async validateRegisteredEffective(options) {
      if (!transport.validateRegisteredEffective)
        return unsupportedValidation("validateRegisteredEffective");
      return transport.validateRegisteredEffective(options);
    },
    async registerSchema(request, options) {
      if (!transport.registerSchema)
        return unsupportedRegistration("registerSchema");
      return transport.registerSchema(request, options);
    },
  };
}

function batchMethods({
  namespace,
  transport,
}: ClientState): Pick<
  WeaverClient,
  "setMany" | "setNamespace" | "listScopes" | "listScopeValues"
> {
  return {
    async setMany(
      entries: Record<string, unknown>,
      opts?: WriteOptions,
    ): Promise<WriteResult> {
      const prefixed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entries)) {
        prefixed[applyNamespace(namespace, key)] = value;
      }
      return transport.setMany(prefixed, opts);
    },

    async setNamespace(
      prefix: string,
      values: Record<string, unknown>,
      opts?: WriteOptions,
    ): Promise<WriteResult> {
      const resolvedPrefix = applyNamespace(namespace, prefix);
      return transport.setMany({ [resolvedPrefix]: values }, opts);
    },

    async listScopes() {
      return transport.listScopes();
    },

    async listScopeValues(scopeId: string, parentScope?: ScopeInstance[]) {
      return transport.listScopeValues(scopeId, parentScope);
    },
  };
}

function listenerMethods({
  changeListeners,
  restartListeners,
}: ClientState): Pick<WeaverClient, "onChange" | "onRestartRequired"> {
  return {
    onChange(
      pattern: string,
      handler: (changes: ConfigDelta[]) => void,
    ): Unsubscribe {
      if (!changeListeners.has(pattern)) {
        changeListeners.set(pattern, new Set());
      }
      const listeners = changeListeners.get(pattern);
      if (listeners === undefined) {
        throw new Error(`Change listener set missing for pattern: ${pattern}`);
      }
      listeners.add(handler);
      return () => {
        changeListeners.get(pattern)?.delete(handler);
      };
    },

    onRestartRequired(handler: () => void): Unsubscribe {
      restartListeners.add(handler);
      return () => {
        restartListeners.delete(handler);
      };
    },
  };
}

function statusMethods(
  state: ClientState,
): Pick<
  WeaverClient,
  | "pendingRestart"
  | "mode"
  | "revision"
  | "connected"
  | "lastSyncedAt"
  | "staleSince"
> {
  return {
    get pendingRestart(): boolean {
      return state.pendingRestart;
    },

    get mode() {
      if (state.connected) return "live" as const;
      if (state.revision) return "cached" as const;
      return "degraded" as const;
    },

    get revision(): string {
      return state.revision;
    },

    get connected(): boolean {
      return state.connected;
    },

    get lastSyncedAt(): Date | null {
      return state.lastSyncedAt;
    },

    get staleSince(): Date | null {
      return (
        state.closedAt ?? state.staleSince ?? state.stalenessMonitor.staleSince
      );
    },
  };
}

function validationMethods(
  state: ClientState,
): Pick<WeaverClient, "validate" | "isSensitive" | "preloadScope" | "close"> {
  const { namespace, registry, scopeLoader, transport } = state;
  return {
    validate(key: string, value: unknown): ValidationResult {
      const resolvedKey = applyNamespace(namespace, key);
      if (!registry) return { valid: true };
      return registry.validate(resolvedKey, value);
    },

    isSensitive(key: string): boolean {
      const resolvedKey = applyNamespace(namespace, key);
      if (!registry) return false;
      return registry.isSensitive(resolvedKey);
    },

    async close(): Promise<void> {
      state.unsubTransport();
      state.connected = false;
      state.closedAt = new Date();
      state.stalenessMonitor.dispose();
      await transport.close();
    },

    async preloadScope(scopePath: ScopeInstance[]): Promise<void> {
      await scopeLoader.preloadScope(scopePath);
    },
  };
}

function instanceClient(
  { namespace, baseState, transport }: ClientState,
  client: WeaverClient,
  basePath: string,
  instanceId: string,
) {
  const resolvedBase = applyNamespace(namespace, basePath);
  return createInstanceClient(resolvedBase, instanceId, {
    getState: () => baseState,
    set: (key, value, opts) => transport.set(key, value, opts),
    remove: (key, opts) => transport.remove(key, opts),
    onChange: (pattern, handler) => client.onChange(pattern, handler),
  });
}
