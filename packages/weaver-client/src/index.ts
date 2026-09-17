export type { WeaverClient, WeaverClientOptions } from "./client";
export { createWeaverClient } from "./client";
export { flattenObject } from "./flatten";
export type { FileSystemPersistenceOptions } from "./fs-persistence";
export { createFileSystemPersistence } from "./fs-persistence";
export {
  HttpResponseContractError,
  HttpServerResponseError,
} from "./http-request";
export { fetchWithRetry, type RetryOptions } from "./http-retry";
export type { HttpTransportOptions, TransportError } from "./http-transport";
export { createHttpTransport } from "./http-transport";
export type { IndexedDbPersistenceOptions } from "./indexeddb-persistence";
export { createIndexedDbPersistence } from "./indexeddb-persistence";
export type { InstanceClientDeps } from "./instance-client";
export { createInstanceClient } from "./instance-client";
export type {
  LocalTransport,
  LocalTransportOptions,
} from "./local-transport";
export { createLocalTransport } from "./local-transport";
export type { TransportMiddleware } from "./middleware";
export { withMiddleware } from "./middleware";
export type {
  InstanceClient,
  NamespaceDefinition,
  TypedInstanceClient,
  TypedNamespaceClient,
  UntypedNamespaceClient,
} from "./namespace";
export { defineNamespace } from "./namespace";
export type { WeaverClientPersistence } from "./persistence";
export type { ClientSchemaRegistry, ValidationResult } from "./schema-registry";
export { createClientSchemaRegistry } from "./schema-registry";
export type {
  ScopeLoader,
  ScopeLoaderOptions,
  ScopeLoadingMode,
} from "./scope-manager";
export { createScopeLoader } from "./scope-manager";
export type { StalenessConfig, StalenessMonitor } from "./staleness";
export { createStalenessMonitor } from "./staleness";
export {
  createSyncRuntimeBridge,
  type SyncRuntimeBridge,
  type SyncRuntimeBridgeOptions,
} from "./sync-runtime-bridge";
export { createWeaverSyncTransport } from "./sync-transport-adapter";
export type {
  WeaverTransport,
  WriteOptions,
  WriteResult,
} from "./transport";
export type { NamespaceClientDeps } from "./typed-namespace-client";
export { createTypedNamespaceClient } from "./typed-namespace-client";
export type {
  ClientLayerInspection,
  ClientMode,
  ConfigDelta,
  ConfigSnapshot,
  ConfigurationInspection,
  GetOptions,
  ResolveOptions,
  SchemaOptions,
  Unsubscribe,
} from "./types";
export type { UntypedNamespaceClientDeps } from "./untyped-namespace-client";
export { createUntypedNamespaceClient } from "./untyped-namespace-client";
export type { ValidationOptions } from "./validation";
export { validateOnRead, validateOnWrite } from "./validation";
export type { WriteQueue } from "./write-queue";
export { createWriteQueue } from "./write-queue";
