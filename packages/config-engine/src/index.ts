// @weaver-conf/config-engine — Configuration resolution engine (iteration 1)

// contract-derivation.ts — Package.json contract metadata extraction
export type {
  ContractMetadata,
  PackageJsonInput,
} from "./contract-derivation";
// deep.ts — Deep object path utilities
export { deepGet, deepRemove, deepSet } from "./deep";
export { deepEqual } from "./deep-equal";
export { matchGlob } from "./glob-match";
// json-schema-generator.ts — JSON Schema generation
export type {
  JsonSchemaDocument,
  JsonSchemaProperty,
} from "./json-schema-generator";
// layers.ts — Layer resolution engine
export type { ResolvedConfiguration } from "./layers";
// merge.ts — Deep merge utility
export { deepMerge } from "./merge";
// namespace.ts — Namespace utilities
// path.ts — Bracket-aware path parsing
export { buildPath, parsePath } from "./path";
export { clearRegexCache, getCachedRegex, isSafePattern } from "./regex-cache";
export type {
  DerivedFragmentPath,
  DerivedServicePath,
} from "./registration-paths";
export {
  assertPublicConfigPath,
  deriveCanonicalSlotPath,
  deriveFragmentPath,
  deriveServicePath,
  isWeaverInternalPath,
  normalizeConfigPath,
  WEAVER_INTERNAL_ROOT,
} from "./registration-paths";
// schema-diff.ts — Schema comparison utilities
export type { BreakingChange } from "./schema-diff";
export {
  detectBreakingChanges,
  diffSchemaKeys,
  getSchemaProperties,
  getSchemaPropertyType,
  schemasEqual,
} from "./schema-diff";
// schema-registry.ts — Schema aggregation
export type {
  ComposedSchemaEntry,
  ComposeResult,
  ConfigurationSchemaDeclaration,
  ConfigurationSchemaRegistry,
  RegisterSchemaResult,
  SchemaCompositionError,
  UnregisterSchemaResult,
} from "./schema-registry";
export { createSchemaRegistry } from "./schema-registry";
// scope.ts — Scope chain builder
export type { BuildScopeChainResult, ScopeChainEntry } from "./scope";
// utils — shared utilities (formerly @weaver-conf/storage-provider-core)
export { cloneValue } from "./utils/clone";
export { extractErrorMessage, isNodeError } from "./utils/error-utils";
export type { LogFields, WeaverLogger } from "./utils/logger";
export { consoleLogger } from "./utils/logger";
export { safeParseConfigEntries } from "./utils/validation";
export { readonlyGuard } from "./utils/write-utils";
