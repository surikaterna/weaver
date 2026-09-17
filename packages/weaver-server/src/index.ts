// @weaver-conf/weaver-server — Central configuration server

export type { WeaverLogger } from "@weaver-conf/config-engine";
export { consoleLogger } from "@weaver-conf/config-engine";
export type {
  MaintenanceStatus,
  UpgradeApplyRequest,
  UpgradeExecutionResult,
  UpgradeRecoveryRequest,
} from "@weaver-conf/config-types";
export type {
  AuditService,
  AuditServiceOptions,
} from "./audit/audit-service";
export { createAuditService } from "./audit/audit-service";
export { createFileSystemAuditLog } from "./audit/fs-audit-log";
export { createInMemoryAuditLog } from "./audit/memory-audit-log";
export type {
  MongoAuditSinkOptions,
  MongoCollection,
} from "./audit/mongo-sink";
export { createMongoAuditSink } from "./audit/mongo-sink";
export { createStdoutAuditSink } from "./audit/stdout-sink";
export type {
  ConfigAuditEntry,
  ConfigAuditLog,
  ConfigAuditSink,
  ConfigDomainAuditEntry,
  SinkDomainAuditEntry,
} from "./audit/types";
export type {
  AuthContext,
  AuthMiddleware,
  AuthMiddlewareOptions,
  JwtIdentity,
  JwtValidator,
  JwtValidatorOptions,
} from "./auth/index";
// auth
export {
  createAuthMiddleware,
  createJwtValidator,
} from "./auth/index";
export type {
  BootstrapAdministrator,
  BootstrapCredentials,
  BootstrapRuntimeOptions,
  InstalledProviderFactory,
  ProviderBuildContext,
  ProviderFactories,
  ProviderResource,
} from "./bootstrap/index";
export {
  authenticateBootstrapAdministrator,
  createBuiltinProviderFactories,
  initializeWeaver,
  inspectWeaver,
  readBootstrapSeed,
} from "./bootstrap/index";
export {
  builtinCatalogReference,
  prepareBuiltinCatalog,
  readBuiltinRecoveryEnvelope,
} from "./core/builtin-catalog";
export type {
  ChangeDetector,
  ChangeDetectorOptions,
  DeprovisionScopeRequest,
  EffectiveValidationContext,
  OverrideSessionInfo,
  OverrideSessionRequest,
  PromotionEngine,
  PromotionEngineOptions,
  PromotionRequest,
  PromotionResult,
  ProvisionScopeRequest,
  RegisteredSchemaAnchor,
  RollbackRequest,
  RollbackResult,
  RollbackService,
  RollbackServiceOptions,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
  SchemaRegistry,
  SchemaRegistryOptions,
  SchemaWriteContext,
  ScopeManager,
  ScopeManagerOptions,
  ScopeProvisionResult,
  SessionManager,
  SessionManagerOptions,
  WeaverConfigService,
  WeaverConfigServiceOptions,
  WebhookHandler,
  WebhookHandlerOptions,
  WriteContext,
} from "./core/index";
// core
export {
  buildScopePathString,
  createChangeDetector,
  createControlService,
  createPromotionEngine,
  createRollbackService,
  createSchemaRegistry,
  createScopeManager,
  createSessionManager,
  createWeaverConfigService,
  createWebhookHandler,
  isScopedLayer,
  parseScopeLayer,
  parseScopeQuery,
  registeredSchemaAnchorSchema,
} from "./core/index";
export type { HealthEndpoints, HealthStatus } from "./health";
// health & shutdown
export { createHealthEndpoints } from "./health";
// providers
export type {
  FileSystemProviderOptions,
  FileSystemStorageProvider,
  GitManager,
  GitManagerOptions,
  GitStorageProviderOptions,
  InMemoryProviderOptions,
  MongoDBStorageProviderOptions,
} from "./providers/index";
export {
  createFileSystemStorageProvider,
  createGitManager,
  createGitStorageProvider,
  createInMemoryStorageProvider,
  createMongoDBStorageProvider,
} from "./providers/index";
export type { WeaverServer, WeaverServerOptions } from "./server";
// server
export { startWeaverServer } from "./server";
export { bootstrapCredentialsFromEnvironment } from "./server-env";
export { openWeaverRuntime, WeaverRuntime } from "./server-runtime";
export type { ShutdownManager, ShutdownManagerOptions } from "./shutdown";
export { createShutdownManager } from "./shutdown";
export type {
  RestAdapter,
  RestAdapterOptions,
  RestRequest,
  RestResponse,
  RestRoute,
  ScompServiceDeps,
  SSEAdapter,
  SSEAdapterOptions,
  SSEChangeEvent,
  SSECheckpointEvent,
  SSEClient,
  SSEClientOptions,
  SSEEventType,
  SSEMessage,
  SSESnapshotEvent,
  WeaverConfigContract,
} from "./transport/index";
// transport
export {
  configBatchBodySchema,
  configWriteBodySchema,
  createRestAdapter,
  createSSEAdapter,
  createWeaverScompService,
  formatSSEMessage,
  fragmentSchemaRegistrationBodySchema,
  matchGlob,
  scopeProvisionBodySchema,
  serviceSchemaRegistrationBodySchema,
  sseChangeEventSchema,
  sseCheckpointEventSchema,
  sseSnapshotEventSchema,
  WEAVER_CONFIG_V1,
} from "./transport/index";
export type {
  ConfigDelta,
  ConfigSnapshot,
  WeaverError,
  WeaverErrorCode,
} from "./types/index";
// types
export {
  configDeltaSchema,
  configSnapshotSchema,
  createWeaverError,
  HTTP_STATUS_MAP,
  httpStatusForError,
  weaverErrorCodeSchema,
  weaverErrorCodes,
  weaverErrorSchema,
} from "./types/index";
