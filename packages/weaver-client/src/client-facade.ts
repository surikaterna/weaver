import { deepGet } from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import { applyNamespace } from "./client-helpers";
import type { ClientRuntime } from "./client-runtime";
import type { WeaverClient } from "./client-types";
import {
  unsupportedRegistration,
  unsupportedValidation,
  unsupportedWrite,
} from "./client-unsupported";
import { createInstanceClient } from "./instance-client";
import { createNamespaceClient } from "./namespace-client";
import type { ValidationResult } from "./schema-registry";
import type { WriteOptions, WriteResult } from "./transport";
import type {
  ConfigDelta,
  ConfigurationInspection,
  Unsubscribe,
} from "./types";
import { validateOnRead, validateOnWrite } from "./validation";

type ClientReference = () => WeaverClient;

export function createClientFacade(runtime: ClientRuntime): WeaverClient {
  let client: WeaverClient;
  const reference = () => client;
  client = {
    ...valueReadMethods(runtime),
    ...namespaceReadMethods(runtime),
    ...writeMethods(runtime),
    ...registeredMethods(runtime),
    ...scopeMethods(runtime),
    ...eventMethods(runtime),
    ...validationMethods(runtime),
    ...lifecycleMethods(runtime),
    ...instanceMethods(runtime, reference),
    ...namespaceMethods(runtime, reference),
    get pendingRestart() {
      return runtime.state.pendingRestart;
    },
    get mode() {
      if (runtime.state.connected) return "live";
      if (runtime.revision) return "cached";
      return "degraded";
    },
    get revision() {
      return runtime.revision;
    },
    get connected() {
      return runtime.state.connected;
    },
    get lastSyncedAt() {
      return runtime.state.lastSyncedAt;
    },
    get staleSince() {
      return (
        runtime.state.closedAt ??
        runtime.state.staleSince ??
        runtime.stalenessMonitor.staleSince
      );
    },
  };
  return client;
}

function valueReadMethods(
  runtime: ClientRuntime,
): Pick<WeaverClient, "get" | "getWithDefault" | "getForScope"> {
  function get<T>(key: string, scopePath?: ScopeInstance[]): T | undefined {
    const resolvedKey = applyNamespace(runtime.namespace, key);
    const source = scopePath
      ? runtime.scopeLoader.getScopeState(scopePath)
      : runtime.baseState;
    if (!source) return undefined;
    // SAFETY: stored values are exposed through the caller-selected generic.
    const value = deepGet(source, resolvedKey) as T | undefined;
    // SAFETY: validation preserves the selected value type or returns undefined.
    return validateOnRead(
      resolvedKey,
      value,
      runtime.registry,
      runtime.validationOptions,
    ) as T | undefined;
  }
  return {
    get,
    getWithDefault<T>(
      key: string,
      defaultValue: T,
      scopePath?: ScopeInstance[],
    ) {
      const value = get<T>(key, scopePath);
      return value !== undefined ? value : defaultValue;
    },
    getForScope<T>(key: string, scopePath: ScopeInstance[]) {
      return get<T>(key, scopePath);
    },
  };
}

function namespaceReadMethods(
  runtime: ClientRuntime,
): Pick<WeaverClient, "getNamespace" | "inspect"> {
  return {
    getNamespace(prefix: string, scopePath?: ScopeInstance[]) {
      const resolvedPrefix = applyNamespace(runtime.namespace, prefix);
      const source = scopePath
        ? (runtime.scopeLoader.getScopeState(scopePath) ?? {})
        : runtime.baseState;
      const value = deepGet(source, resolvedPrefix);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {};
      }
      // SAFETY: the runtime object checks establish the record boundary.
      return value as Record<string, unknown>;
    },
    async inspect<T>(key: string) {
      const resolvedKey = applyNamespace(runtime.namespace, key);
      // SAFETY: the transport contract supplies ConfigurationInspection values.
      return (await runtime.transport.inspect(
        resolvedKey,
      )) as ConfigurationInspection<T>;
    },
  };
}

function writeMethods(
  runtime: ClientRuntime,
): Pick<WeaverClient, "set" | "remove" | "setMany" | "setNamespace"> {
  return {
    async set(key, value, options) {
      const resolvedKey = applyNamespace(runtime.namespace, key);
      const result = validateOnWrite(resolvedKey, value, runtime.registry);
      if (result.valid)
        return runtime.transport.set(resolvedKey, value, options);
      return validationFailure(result.errors);
    },
    async remove(key, options) {
      return runtime.transport.remove(
        applyNamespace(runtime.namespace, key),
        options,
      );
    },
    async setMany(entries, options) {
      const prefixed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entries)) {
        prefixed[applyNamespace(runtime.namespace, key)] = value;
      }
      return runtime.transport.setMany(prefixed, options);
    },
    async setNamespace(prefix, values, options) {
      const path = applyNamespace(runtime.namespace, prefix);
      return runtime.transport.setMany({ [path]: values }, options);
    },
  };
}

function validationFailure(errors: ValidationResult["errors"]): WriteResult {
  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message:
        errors.map((error) => error.message).join(", ") || "Validation failed",
      details: { errors },
    },
  };
}

function registeredMethods(
  runtime: ClientRuntime,
): Pick<
  WeaverClient,
  | "setRegisteredObject"
  | "patchRegisteredPath"
  | "validateRegisteredEffective"
  | "registerSchema"
> {
  return {
    async setRegisteredObject(path, value, options) {
      return (
        runtime.transport.setRegisteredObject?.(path, value, options) ??
        unsupportedWrite("setRegisteredObject")
      );
    },
    async patchRegisteredPath(path, value, options) {
      return (
        runtime.transport.patchRegisteredPath?.(path, value, options) ??
        unsupportedWrite("patchRegisteredPath")
      );
    },
    async validateRegisteredEffective(options) {
      return (
        runtime.transport.validateRegisteredEffective?.(options) ??
        unsupportedValidation("validateRegisteredEffective")
      );
    },
    async registerSchema(request) {
      return (
        runtime.transport.registerSchema?.(request) ??
        unsupportedRegistration("registerSchema")
      );
    },
  };
}

function scopeMethods(
  runtime: ClientRuntime,
): Pick<WeaverClient, "listScopes" | "listScopeValues" | "preloadScope"> {
  return {
    async listScopes() {
      return runtime.transport.listScopes();
    },
    async listScopeValues(scopeId, parentScope) {
      return runtime.transport.listScopeValues(scopeId, parentScope);
    },
    async preloadScope(scopePath) {
      await runtime.scopeLoader.preloadScope(scopePath);
    },
  };
}

function eventMethods(
  runtime: ClientRuntime,
): Pick<WeaverClient, "onChange" | "onRestartRequired"> {
  return {
    onChange(pattern: string, handler: (changes: ConfigDelta[]) => void) {
      const listeners = runtime.changeListeners.get(pattern) ?? new Set();
      runtime.changeListeners.set(pattern, listeners);
      listeners.add(handler);
      return () => {
        runtime.changeListeners.get(pattern)?.delete(handler);
      };
    },
    onRestartRequired(handler: () => void): Unsubscribe {
      runtime.restartListeners.add(handler);
      return () => {
        runtime.restartListeners.delete(handler);
      };
    },
  };
}

function validationMethods(
  runtime: ClientRuntime,
): Pick<WeaverClient, "validate" | "isSensitive"> {
  return {
    validate(key, value) {
      const resolvedKey = applyNamespace(runtime.namespace, key);
      return (
        runtime.registry?.validate(resolvedKey, value) ?? {
          valid: true,
          errors: [],
        }
      );
    },
    isSensitive(key) {
      const resolvedKey = applyNamespace(runtime.namespace, key);
      return runtime.registry?.isSensitive(resolvedKey) ?? false;
    },
  };
}

function lifecycleMethods(runtime: ClientRuntime): Pick<WeaverClient, "close"> {
  return {
    async close() {
      runtime.unsubscribe();
      runtime.state.connected = false;
      runtime.state.closedAt = new Date();
      runtime.stalenessMonitor.dispose();
      await runtime.transport.close();
    },
  };
}

function instanceMethods(
  runtime: ClientRuntime,
  client: ClientReference,
): Pick<WeaverClient, "instance"> {
  return {
    instance<TConfig extends object>(basePath: string, instanceId: string) {
      const resolvedBase = applyNamespace(runtime.namespace, basePath);
      return createInstanceClient<TConfig>(resolvedBase, instanceId, {
        getState: () => runtime.baseState,
        set: (key, value, options) =>
          runtime.transport.set(key, value, options),
        remove: (key, options) => runtime.transport.remove(key, options),
        onChange: (pattern, handler) => client().onChange(pattern, handler),
      });
    },
  };
}

function namespaceMethods(
  runtime: ClientRuntime,
  client: ClientReference,
): Pick<WeaverClient, "namespace"> {
  return {
    namespace<TConfig extends object>(path: string) {
      return createNamespaceClient<TConfig>(
        applyNamespace(runtime.namespace, path),
        namespaceDeps(runtime, client),
      );
    },
  };
}

function namespaceDeps(runtime: ClientRuntime, client: ClientReference) {
  return {
    getState: (scopePath?: ScopeInstance[]) =>
      scopePath
        ? (runtime.scopeLoader.getScopeState(scopePath) ?? {})
        : runtime.baseState,
    set: (key: string, value: unknown, options?: WriteOptions) =>
      runtime.transport.set(key, value, options),
    setMany: (entries: Record<string, unknown>, options?: WriteOptions) =>
      runtime.transport.setMany(entries, options),
    remove: (key: string, options?: WriteOptions) =>
      runtime.transport.remove(key, options),
    onChange: (pattern: string, handler: (changes: ConfigDelta[]) => void) =>
      client().onChange(pattern, handler),
  };
}
