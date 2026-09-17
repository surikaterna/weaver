// @weaver-conf/config-types — Configuration type definitions and Zod schemas

// access.ts — Permission types and default policies
export type {
  ConfigurationAccessContext,
  ConfigurationSchemaFragment,
  LayerWriteConstraint,
  LayerWritePolicy,
  ServiceAccessPolicy,
  ServiceConfigurationDeclaration,
} from "./access";
export {
  type BootstrapSeed,
  bootstrapSeedSchema,
  bootstrapStoreSchema,
  type InitializeWeaverRequest,
  initializeWeaverRequestSchema,
  type WeaverInspection,
  type WeaverRuntimeState,
  type WeaverRuntimeStatus,
  weaverInspectionSchema,
  weaverRuntimeStateSchema,
  weaverRuntimeStatusSchema,
} from "./bootstrap-seed";
// cache.ts — Scope resolution cache interface
export type { ScopeResolutionCache } from "./cache";
export { formatScopePath, serializeScopePath } from "./cache";
// environment.ts — Environment-aware provider types and provenance tracking
export type { EnvironmentName } from "./environment";
export { environmentNamePattern, environmentNameSchema } from "./environment";
export type { WeaverError, WeaverErrorCode } from "./errors";
// errors.ts — Shared error taxonomy
export {
  createWeaverError,
  WeaverErrorInstance,
  weaverErrorCodeSchema,
  weaverErrorCodes,
  weaverErrorSchema,
} from "./errors";
// expressions.ts — Expression evaluator interface
export type {
  ExpressionEvaluatorProvider,
  ExpressionValidationResult,
} from "./expressions";
export * from "./internal-contracts";
// layer-factories.ts — Built-in layer factories
export { Layers, replaceOnly } from "./layer-factories";
// layers.ts — Layer abstraction interfaces
export type {
  DynamicLayerConfig,
  EphemeralLayerConfig,
  LayerData,
  LayerDefinition,
  LayerResolver,
  LayerType,
  PersonalLayerConfig,
  ResolutionContext,
  StaticLayerConfig,
} from "./layers";
// markers.ts — _weaver marker types and type guards
export type { ConfigMount, SecretReference, WeaverMarker } from "./markers";
export { isConfigMount, isSecretReference, isWeaverMarker } from "./markers";
// merge-types.ts — Merge function type
export type { MergeFunction } from "./merge-types";
// promotion-types.ts — Promotion pipeline, audit, and emergency override types
export type {
  AuditEntryBase,
  ConfigAuditEntry,
  ConfigDomainAuditEntry,
  EmergencyOverrideRecord,
  PromotionRequest,
  PromotionStatus,
  SchemaAuditAction,
  SchemaDomainAuditEntry,
  SchemaOperationAuditMetadata,
  SecretDomainAuditEntry,
  SessionDomainAuditEntry,
  SinkDomainAuditEntry,
} from "./promotion-types";
// property-schema.ts — Property schema and policy types
export type {
  ConfigChangePolicy,
  ConfigReloadBehavior,
  ConfigurationJsonSchemaType,
  ConfigurationPropertySchema,
  ConfigurationRole,
  ConfigurationVisibility,
  ObjectConfigurationPropertySchema,
  WeaverPropertyExtensions,
} from "./property-schema";
export {
  authoritySequenceSchema,
  type FileAuthorityOptions,
  fileAuthorityOptionsSchema,
  type LayerCommitRequest,
  type LayerCommitResult,
  type LayerEnvelope,
  layerCommitReceiptSchema,
  layerCommitRequestSchema,
  layerCommitResultSchema,
  layerEnvelopeSchema,
  type MongoLayerEnvelope,
  mongoLayerEnvelopeSchema,
  type ProviderAuthority,
  type ProviderCapabilities,
  type ProviderInventory,
  type ProviderMutation,
  type ProviderOwnership,
  type ProviderPreflight,
  type ProviderRevision,
  type ProviderWriterHandle,
  providerCapabilitiesSchema,
  providerInventorySchema,
  providerMutationSchema,
  providerOwnershipSchema,
  providerPreflightSchema,
  providerRevisionSchema,
  type StorageAuthorityOptions,
  storageAuthorityOptionsSchema,
} from "./provider-authority";
// providers.ts — Storage provider interfaces
export type {
  ConfigSyncAckRequest,
  ConfigSyncAckResponse,
  ConfigSyncPullRequest,
  ConfigSyncPullResponse,
  ConfigSyncPushRequest,
  ConfigSyncPushResponse,
  ConfigSyncPushResult,
  ConfigSyncTransport,
  ConfigurationChange,
  ConfigurationConflict,
  ConfigurationStorageProvider,
  DurableConfigCache,
  SyncConflictMetadata,
  SyncCursor,
  SyncErrorCode,
  SyncErrorMetadata,
  SyncMutationMetadata,
  SyncMutationOperation,
  SyncMutationQueue,
  SyncQueuedMutation,
  SyncQueueMetadata,
  SyncRemoteChange,
  SyncResult,
  SyncSnapshotCache,
  SyncStatus,
  WriteError,
  WriteResult,
} from "./providers";
export { isSafePattern } from "./regex-safety";
export type {
  RegisteredEffectiveValidationRequest,
  RegisteredEffectiveValidationResponse,
  RegisteredObjectWriteRequest,
  RegisteredObjectWriteResponse,
  RegisteredPathPatchRequest,
  RegisteredPathPatchResponse,
  RegisteredSchemasResponse,
  RegisteredWriteOptions,
} from "./registered-operations";
export { containsRegistrationDefaultMarker } from "./registration-default-markers";
// result.ts — Discriminated Result<T,E> union for fallible operations
export type { Result } from "./result";
export { err, isErr, isOk, ok } from "./result";
export { type RollbackRequest, rollbackRequestSchema } from "./rollback";
// schema-registration.ts — Path-first schema registration contracts
export type {
  FragmentSchemaRegistrationRequest,
  FragmentSlotDeclaration,
  FragmentSlotRegistrationMetadata,
  RegistrationOwner,
  SchemaRegistrationAuditMetadata,
  SchemaRegistrationContext,
  SchemaRegistrationMetadata,
  SchemaRegistrationOperation,
  SchemaRegistrationOptions,
  SchemaRegistrationRequest,
  SchemaRegistrationResponse,
  ServiceSchemaRegistrationRequest,
} from "./schema-registration";
export type {
  SchemaValidationError,
  SchemaValidationErrorCode,
  SchemaValidationPathSegment,
  SchemaValidationResult,
} from "./schema-validation";
// schemas-access.ts — Zod schemas for access context and write policy types
export {
  configurationAccessContextSchema,
  configurationSchemaFragmentSchema,
  layerWriteConstraintSchema,
  layerWritePolicySchema,
  serviceAccessPolicySchema,
  serviceConfigurationDeclarationSchema,
} from "./schemas-access";
// schemas-expression.ts — Zod schemas for expression validation types
export { expressionValidationResultSchema } from "./schemas-expression";
// schemas-layers.ts — Zod schemas for layer and context types
export {
  configurationContextSchema,
  configurationLayerDataSchema,
  configurationLayerEntrySchema,
  configurationLayerSchema,
  configurationLayerStackSchema,
  scopeDefinitionSchema,
  scopeHierarchySchema,
  scopeInstanceSchema,
  tenantScopeHierarchySchema,
} from "./schemas-layers";
// schemas-markers.ts — Zod schemas for marker types
export {
  configMountSchema,
  secretReferenceSchema,
  weaverMarkerSchema,
} from "./schemas-markers";
// schemas-policy.ts — Zod schemas for change policy, visibility, and role types
export {
  configChangePolicySchema,
  configReloadBehaviorSchema,
  configurationJsonSchemaTypeSchema,
  configurationRoleSchema,
  configurationVisibilitySchema,
  propertySessionModeSchema,
  weaverPropertyExtensionsSchema,
} from "./schemas-policy";
// schemas-promotion.ts — Zod schemas for promotion types
export {
  configAuditEntrySchema,
  configDomainAuditEntrySchema,
  emergencyOverrideRecordSchema,
  promotionRequestSchema,
  promotionStatusSchema,
  schemaAuditActionSchema,
  schemaDomainAuditEntrySchema,
  schemaOperationAuditMetadataSchema,
  secretDomainAuditEntrySchema,
  sessionDomainAuditEntrySchema,
  sinkDomainAuditEntrySchema,
} from "./schemas-promotion";
// schemas-property.ts — Zod schemas for configuration property schema types
export {
  configurationPropertySchemaSchema,
  objectConfigurationPropertySchemaSchema,
} from "./schemas-property";
// schemas-providers.ts — Zod schemas for provider types
export {
  configurationChangeSchema,
  configurationConflictSchema,
  configurationInspectionSchema,
  syncQueueMetadataSchema,
  syncResultSchema,
  syncStatusConflictSchema,
  syncStatusErrorSchema,
  syncStatusOfflineSchema,
  syncStatusSchema,
  syncStatusSyncedSchema,
  syncStatusSyncingSchema,
  writeResultSchema,
} from "./schemas-providers";
export {
  registeredEffectiveValidationRequestSchema,
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteRequestSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchRequestSchema,
  registeredPathPatchResponseSchema,
  registeredSchemasResponseSchema,
} from "./schemas-registered-operations";
// schemas-schema-registration.ts — Zod schemas for path-first schema registration contracts
export {
  registeredConfigurationSchemaSchema,
  visitConfigurationSchemas,
} from "./schemas-registration-grammar";
export {
  providerIdPattern,
  providerIdSchema,
  publicConfigPathSchema,
  serviceIdPattern,
  serviceIdSchema,
  slotPathSchema,
} from "./schemas-registration-paths";
export {
  fragmentSchemaRegistrationRequestSchema,
  fragmentSlotDeclarationSchema,
  fragmentSlotRegistrationMetadataSchema,
  registrationOwnerSchema,
  schemaRegistrationAuditMetadataSchema,
  schemaRegistrationContextSchema,
  schemaRegistrationMetadataSchema,
  schemaRegistrationOperationSchema,
  schemaRegistrationOptionsSchema,
  schemaRegistrationResponseSchema,
  serviceSchemaRegistrationRequestSchema,
} from "./schemas-schema-registration";
export {
  schemaValidationErrorCodeSchema,
  schemaValidationErrorSchema,
  schemaValidationPathSegmentSchema,
  schemaValidationResultSchema,
} from "./schemas-schema-validation";
// schemas-session.ts — Zod schemas for session types
export {
  godModeSessionSchema,
  overrideSessionSchema,
  sessionActivationRequestSchema,
  sessionDeactivationResultSchema,
  sessionLayerMetadataSchema,
  sessionModeSchema,
  sessionTypeSchema,
} from "./schemas-session";
export type { ConfigDelta, ConfigSnapshot } from "./schemas-transport";
// schemas-transport.ts — Zod schemas for transport types (ConfigDelta, ConfigSnapshot)
export {
  configDeltaSchema,
  configSnapshotSchema,
} from "./schemas-transport";
export {
  type AuthorityVector,
  authorityVectorSchema,
  type ScopeInventory,
  type ServiceAuthoritySnapshot,
  scopeInventorySchema,
  serviceAuthoritySnapshotSchema,
} from "./scope-inventory";
export {
  type ScopeLifecycleRequest,
  type ScopeLifecycleResult,
  scopeLifecycleRequestSchema,
  scopeLifecycleResultSchema,
} from "./scope-lifecycle";
// service.ts — Service interfaces
export type {
  ConfigurationInspection,
  ConfigurationService,
  ConfigurationSessionHandle,
  ScopedConfigurationService,
  ServiceConfigurationService,
  ViewConfigurationService,
} from "./service";
// session.ts — Session layer types
export type {
  GodModeSession,
  OverrideSession,
  PropertySessionMode,
  SessionActivationRequest,
  SessionDeactivationResult,
  SessionLayer,
  SessionLayerMetadata,
  SessionMode,
  SessionType,
} from "./session";
// type-utils.ts — Compile-time mapped types for typesafe config access
export type {
  ConfigKeyPath,
  ConfigValueAtPath,
  TypedConfigurationService,
} from "./type-utils";
// types.ts — Layer, context, and stack types
export type {
  ConfigurationContext,
  ConfigurationLayer,
  ConfigurationLayerData,
  ConfigurationLayerEntry,
  ConfigurationLayerStack,
  ScopeDefinition,
  ScopeHierarchy,
  ScopeInstance,
  TenantScopeHierarchy,
  Unsubscribe,
} from "./types";
// view-config-declaration.ts — View config declaration type and factory
export type { ViewConfigDeclaration } from "./view-config-declaration";
export { defineViewConfig } from "./view-config-declaration";
// weaver.ts — defineWeaver() builder
export type { ExtractLayerNames, WeaverConfig } from "./weaver";
export { defineWeaver } from "./weaver";
