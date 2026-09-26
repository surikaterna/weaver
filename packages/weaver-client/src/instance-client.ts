import { buildPath, deepGet, parsePath } from "@weaver-conf/config-engine";
import type { InstanceClient } from "./namespace";
import type { WriteOptions, WriteResult } from "./transport";
import type { ConfigDelta, Unsubscribe } from "./types";

type ConfigKey<TConfig extends object> = Extract<keyof TConfig, string>;

export interface InstanceClientDeps {
  getState: () => Record<string, unknown>;
  set: (
    key: string,
    value: unknown,
    options?: WriteOptions,
  ) => Promise<WriteResult>;
  remove: (key: string, options?: WriteOptions) => Promise<WriteResult>;
  onChange: (
    pattern: string,
    handler: (deltas: ConfigDelta[]) => void,
  ) => Unsubscribe;
  defaultWriteLayer?: string;
}

export function createInstanceClient<
  TConfig extends object = Record<string, unknown>,
>(
  basePath: string,
  instanceId: string,
  deps: InstanceClientDeps,
): InstanceClient<TConfig> {
  const instancePath = buildPath([
    ...parsePath(basePath),
    "instances",
    instanceId,
  ]);

  function get<K extends ConfigKey<TConfig>>(key: K): TConfig[K] | undefined {
    return readInstanceValue<TConfig, K>(basePath, instancePath, key, deps);
  }

  return {
    get,
    getOrDefault(key, defaultValue) {
      const value = get(key);
      return value === undefined ? defaultValue : value;
    },
    async set(key, value, options) {
      return deps.set(
        memberPath(instancePath, key),
        value,
        instanceWriteOptions(deps, options),
      );
    },
    async reset(options) {
      return deps.remove(instancePath, instanceWriteOptions(deps, options));
    },
    onChange(key, handler) {
      const fullKey = memberPath(instancePath, key);
      return deps.onChange(fullKey, (deltas) => {
        for (const delta of deltas) {
          if (delta.key !== fullKey) continue;
          const value = delta.action === "remove" ? undefined : delta.value;
          // Delta values are trusted only through the consumer-selected generic.
          handler(value as TConfig[typeof key] | undefined);
        }
      });
    },
  };
}

function readInstanceValue<
  TConfig extends object,
  K extends ConfigKey<TConfig>,
>(
  basePath: string,
  instancePath: string,
  key: K,
  deps: InstanceClientDeps,
): TConfig[K] | undefined {
  const state = deps.getState();
  const instanceValue = deepGet(state, memberPath(instancePath, key));
  const value =
    instanceValue === undefined
      ? deepGet(state, memberPath(basePath, key))
      : instanceValue;
  // The consumer-supplied generic is compile-time-only; server validation is authoritative.
  return value as TConfig[K] | undefined;
}

function memberPath(path: string, key: string): string {
  return buildPath([...parsePath(path), key]);
}

function instanceWriteOptions(
  deps: InstanceClientDeps,
  options?: WriteOptions,
): WriteOptions | undefined {
  if (deps.defaultWriteLayer === undefined) return options;
  return { layer: deps.defaultWriteLayer, ...options };
}
