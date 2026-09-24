import { deepGet } from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import { createInstanceClient } from "./instance-client";
import type { NamespaceClient } from "./namespace";
import type { WriteOptions, WriteResult } from "./transport";
import type { ConfigDelta, Unsubscribe } from "./types";

type ConfigKey<TConfig extends object> = Extract<keyof TConfig, string>;

export interface NamespaceClientDeps {
  getState: (scopePath?: ScopeInstance[]) => Record<string, unknown>;
  set: (
    key: string,
    value: unknown,
    options?: WriteOptions,
  ) => Promise<WriteResult>;
  setMany: (
    values: Record<string, unknown>,
    options?: WriteOptions,
  ) => Promise<WriteResult>;
  remove: (key: string, options?: WriteOptions) => Promise<WriteResult>;
  onChange: (
    pattern: string,
    handler: (deltas: ConfigDelta[]) => void,
  ) => Unsubscribe;
}

interface NamespaceContext {
  readonly path: string;
  readonly deps: NamespaceClientDeps;
  readonly scopePath?: ScopeInstance[] | undefined;
}

export function createNamespaceClient<
  TConfig extends object = Record<string, unknown>,
>(
  path: string,
  deps: NamespaceClientDeps,
  scopePath?: ScopeInstance[],
): NamespaceClient<TConfig> {
  const context = { path, deps, scopePath };
  return {
    ...namespaceReads<TConfig>(context),
    ...namespaceWrites<TConfig>(context),
    ...namespaceSubscriptions<TConfig>(context),
    ...namespaceViews<TConfig>(context),
  };
}

function namespaceReads<TConfig extends object>(
  context: NamespaceContext,
): Pick<NamespaceClient<TConfig>, "get" | "getOrDefault" | "getAll"> {
  function get<K extends ConfigKey<TConfig>>(key: K): TConfig[K] | undefined {
    const value = deepGet(
      context.deps.getState(context.scopePath),
      resolveKey(context.path, key),
    );
    // The consumer-supplied generic is compile-time-only; server validation is authoritative.
    return value as TConfig[K] | undefined;
  }
  return {
    get,
    getOrDefault(key, defaultValue) {
      const value = get(key);
      return value === undefined ? defaultValue : value;
    },
    getAll() {
      const value = deepGet(
        context.deps.getState(context.scopePath),
        context.path,
      );
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {};
      }
      // The returned object is a compile-time view; no runtime generic proof is claimed.
      return { ...value } as Partial<TConfig>;
    },
  };
}

function namespaceWrites<TConfig extends object>(
  context: NamespaceContext,
): Pick<NamespaceClient<TConfig>, "set" | "setMany" | "remove"> {
  return {
    async set(key, value, options) {
      return context.deps.set(resolveKey(context.path, key), value, options);
    },
    async setMany(values, options) {
      const prefixed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        prefixed[resolveKey(context.path, key)] = value;
      }
      return context.deps.setMany(prefixed, options);
    },
    async remove(key, options) {
      return context.deps.remove(resolveKey(context.path, key), options);
    },
  };
}

function namespaceSubscriptions<TConfig extends object>(
  context: NamespaceContext,
): Pick<NamespaceClient<TConfig>, "onChange"> {
  function onChange<K extends ConfigKey<TConfig>>(
    key: K,
    handler: (value: TConfig[K] | undefined) => void,
  ): Unsubscribe;
  function onChange(handler: (deltas: ConfigDelta[]) => void): Unsubscribe;
  function onChange<K extends ConfigKey<TConfig>>(
    keyOrHandler: K | ((deltas: ConfigDelta[]) => void),
    handler?: (value: TConfig[K] | undefined) => void,
  ): Unsubscribe {
    if (typeof keyOrHandler === "function") {
      return context.deps.onChange(`${context.path}.*`, keyOrHandler);
    }
    const fullKey = resolveKey(context.path, keyOrHandler);
    return context.deps.onChange(fullKey, (deltas) => {
      for (const delta of deltas) {
        if (delta.key !== fullKey) continue;
        const value = delta.action === "remove" ? undefined : delta.value;
        // Delta values are trusted only through the consumer-selected generic.
        handler?.(value as TConfig[K] | undefined);
      }
    });
  }
  return { onChange };
}

function namespaceViews<TConfig extends object>(
  context: NamespaceContext,
): Pick<NamespaceClient<TConfig>, "withScope" | "instance"> {
  return {
    withScope(nextScopePath) {
      return createNamespaceClient<TConfig>(context.path, context.deps, [
        ...(context.scopePath ?? []),
        ...nextScopePath,
      ]);
    },
    instance(instanceId) {
      return createInstanceClient<TConfig>(context.path, instanceId, {
        getState: () => context.deps.getState(context.scopePath),
        set: context.deps.set,
        remove: context.deps.remove,
        onChange: context.deps.onChange,
      });
    },
  };
}

function resolveKey(path: string, key: string): string {
  return `${path}.${key}`;
}
