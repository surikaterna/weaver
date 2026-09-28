import type { ScopeInstance } from "@weaver-conf/config-types";
import type { WriteOptions, WriteResult } from "./transport";
import type { ConfigDelta, Unsubscribe } from "./types";

type ConfigKey<TConfig extends object> = Extract<keyof TConfig, string>;

/** Compile-time typed view over a configuration path. */
export interface NamespaceClient<
  TConfig extends object = Record<string, unknown>,
> {
  get<K extends ConfigKey<TConfig>>(key: K): TConfig[K] | undefined;
  getOrDefault<K extends ConfigKey<TConfig>>(
    key: K,
    defaultValue: TConfig[K],
  ): TConfig[K];
  getAll(): Partial<TConfig>;
  set<K extends ConfigKey<TConfig>>(
    key: K,
    value: TConfig[K],
    options?: WriteOptions,
  ): Promise<WriteResult>;
  setMany(
    values: Partial<TConfig>,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  remove<K extends ConfigKey<TConfig>>(
    key: K,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  onChange<K extends ConfigKey<TConfig>>(
    key: K,
    handler: (value: TConfig[K] | undefined) => void,
  ): Unsubscribe;
  onChange(handler: (deltas: ConfigDelta[]) => void): Unsubscribe;
  withScope(scopePath: ScopeInstance[]): NamespaceClient<TConfig>;
  instance(instanceId: string): InstanceClient<TConfig>;
}

/** Compile-time typed view over one configuration instance. */
export interface InstanceClient<
  TConfig extends object = Record<string, unknown>,
> {
  get<K extends ConfigKey<TConfig>>(key: K): TConfig[K] | undefined;
  getOrDefault<K extends ConfigKey<TConfig>>(
    key: K,
    defaultValue: TConfig[K],
  ): TConfig[K];
  set<K extends ConfigKey<TConfig>>(
    key: K,
    value: TConfig[K],
    options?: WriteOptions,
  ): Promise<WriteResult>;
  reset(options?: WriteOptions): Promise<WriteResult>;
  onChange<K extends ConfigKey<TConfig>>(
    key: K,
    handler: (value: TConfig[K] | undefined) => void,
  ): Unsubscribe;
}
