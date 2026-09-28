import {
  canonicalConfigPathFromStorageKey,
  parseCanonicalConfigPath,
  type SchemaValidationPathSegment,
  type SchemaValidationResult,
  validateConfigurationPatch,
  validateEffectiveConfiguration,
} from "@weaver-conf/config-engine";
import type {
  ConfigReloadBehavior,
  ConfigurationPropertySchema,
} from "@weaver-conf/config-types";

export type ValidationResult = SchemaValidationResult;

/** Client-side view of server schemas for optional validation and metadata. */
export interface ClientSchemaRegistry {
  load(schemas: Record<string, ConfigurationPropertySchema>): void;
  getSchema(key: string): ConfigurationPropertySchema | undefined;
  isSensitive(key: string): boolean;
  getReloadBehavior(key: string): ConfigReloadBehavior | undefined;
  getRestartRequiredKeys(): ReadonlyArray<string>;
  validate(key: string, value: unknown): SchemaValidationResult;
}

interface RegisteredAnchor {
  readonly segments: readonly string[];
  readonly schema: ConfigurationPropertySchema;
}

interface ResolvedTarget {
  readonly anchor: RegisteredAnchor;
  readonly relativeSegments: readonly SchemaValidationPathSegment[];
}

interface RegistryState {
  readonly environment: string;
  readonly anchors: Map<string, RegisteredAnchor>;
}

const reloadPriority: Readonly<Record<ConfigReloadBehavior, number>> = {
  hot: 1,
  "rolling-restart": 2,
  "restart-required": 3,
};

export function createClientSchemaRegistry(
  environment = "default",
): ClientSchemaRegistry {
  const state: RegistryState = { environment, anchors: new Map() };
  return {
    load(input) {
      loadSchemas(state, input);
    },
    getSchema(key) {
      const schemas = getMemberSchemas(state, key);
      return schemas.length === 1 ? schemas[0] : undefined;
    },
    isSensitive(key) {
      return getMemberSchemas(state, key).some(
        (schema) => ownExtension(schema)?.sensitive === true,
      );
    },
    getReloadBehavior(key) {
      return strongestReloadBehavior(getMemberSchemas(state, key));
    },
    getRestartRequiredKeys() {
      return restartRequiredAnchors(state);
    },
    validate(key, value) {
      return validateTarget(state, key, value);
    },
  };
}

function restartRequiredAnchors(state: RegistryState): string[] {
  const keys: string[] = [];
  for (const [path, anchor] of state.anchors) {
    if (ownExtension(anchor.schema)?.reloadBehavior === "restart-required") {
      keys.push(parseCanonicalConfigPath(path).storageKey);
    }
  }
  return keys;
}

function loadSchemas(
  state: RegistryState,
  input: Record<string, ConfigurationPropertySchema>,
): void {
  const loaded = new Map<string, RegisteredAnchor>();
  const suffix = `:${state.environment}`;
  for (const [registryKey, schema] of Object.entries(input)) {
    if (!registryKey.endsWith(suffix)) continue;
    const path = registryKey.slice(0, -suffix.length);
    const canonical = parseCanonicalConfigPath(path);
    if (canonical.path !== path) {
      throw new Error(`Schema registry key is not canonical: ${registryKey}`);
    }
    loaded.set(canonical.path, { segments: canonical.segments, schema });
  }
  state.anchors.clear();
  for (const [path, anchor] of loaded) state.anchors.set(path, anchor);
}

function resolveTarget(
  state: RegistryState,
  key: string,
): ResolvedTarget | undefined {
  let target: ReturnType<typeof canonicalConfigPathFromStorageKey>;
  try {
    target = canonicalConfigPathFromStorageKey(key);
  } catch {
    return undefined;
  }
  if (target.storageKey !== key) return undefined;
  for (let length = target.segments.length; length >= 0; length--) {
    const anchor = state.anchors.get(
      canonicalPath(target.segments.slice(0, length)),
    );
    if (anchor) {
      return { anchor, relativeSegments: target.segments.slice(length) };
    }
  }
  return undefined;
}

function getMemberSchemas(
  state: RegistryState,
  key: string,
): ConfigurationPropertySchema[] {
  const target = resolveTarget(state, key);
  if (!target) return [];
  let candidates = [target.anchor.schema];
  for (const segment of target.relativeSegments) {
    candidates = candidates.flatMap((schema) =>
      resolveMemberSchemas(schema, segment),
    );
    if (candidates.length === 0) break;
  }
  return candidates;
}

function validateTarget(
  state: RegistryState,
  key: string,
  value: unknown,
): SchemaValidationResult {
  const target = resolveTarget(state, key);
  if (!target) return { valid: true, errors: [] };
  if (target.relativeSegments.length === 0) {
    return validateEffectiveConfiguration(target.anchor.schema, value);
  }
  return validateConfigurationPatch(
    target.anchor.schema,
    target.relativeSegments,
    value,
  );
}

function canonicalPath(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function resolveMemberSchemas(
  schema: ConfigurationPropertySchema,
  segment: SchemaValidationPathSegment,
): ConfigurationPropertySchema[] {
  if (allowsType(schema, "object")) {
    return resolveObjectSchemas(schema, String(segment));
  }
  if (allowsType(schema, "array")) return resolveArraySchemas(schema, segment);
  return [];
}

function resolveObjectSchemas(
  schema: ConfigurationPropertySchema,
  key: string,
): ConfigurationPropertySchema[] {
  const matches: ConfigurationPropertySchema[] = [];
  const properties = ownValue(schema, "properties");
  if (properties && Object.hasOwn(properties, key)) {
    const property = properties[key];
    if (property) matches.push(property);
  }
  const patterns = ownValue(schema, "patternProperties");
  for (const [pattern, patternSchema] of Object.entries(patterns ?? {})) {
    if (matchesPattern(pattern, key)) matches.push(patternSchema);
  }
  if (matches.length > 0) return matches;
  const additional = ownValue(schema, "additionalProperties");
  return typeof additional === "object" ? [additional] : [];
}

function resolveArraySchemas(
  schema: ConfigurationPropertySchema,
  segment: SchemaValidationPathSegment,
): ConfigurationPropertySchema[] {
  const index = arrayIndex(segment);
  if (index === undefined) return [];
  const items = ownValue(schema, "items");
  if (!items) return [];
  if (!isSchemaArray(items)) return [items];
  const item = items[index];
  return item ? [item] : [];
}

function isSchemaArray(
  items: ConfigurationPropertySchema | readonly ConfigurationPropertySchema[],
): items is readonly ConfigurationPropertySchema[] {
  return Array.isArray(items);
}

function ownValue<
  Key extends
    | "properties"
    | "patternProperties"
    | "additionalProperties"
    | "items",
>(
  schema: ConfigurationPropertySchema,
  key: Key,
): ConfigurationPropertySchema[Key] {
  return Object.hasOwn(schema, key) ? schema[key] : undefined;
}

function ownExtension(schema: ConfigurationPropertySchema) {
  return Object.hasOwn(schema, "x-weaver") ? schema["x-weaver"] : undefined;
}

function allowsType(
  schema: ConfigurationPropertySchema,
  type: "object" | "array",
): boolean {
  return Array.isArray(schema.type)
    ? schema.type.includes(type)
    : schema.type === type;
}

function matchesPattern(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern, "u").test(key);
  } catch {
    return false;
  }
}

function arrayIndex(segment: SchemaValidationPathSegment): number | undefined {
  const text = String(segment);
  if (!/^(0|[1-9]\d*)$/.test(text)) return undefined;
  const index = Number(text);
  return Number.isSafeInteger(index) && index <= 4_294_967_294
    ? index
    : undefined;
}

function strongestReloadBehavior(
  schemas: readonly ConfigurationPropertySchema[],
): ConfigReloadBehavior | undefined {
  let strongest: ConfigReloadBehavior | undefined;
  for (const schema of schemas) {
    const behavior = ownExtension(schema)?.reloadBehavior;
    if (
      behavior &&
      (!strongest || reloadPriority[behavior] > reloadPriority[strongest])
    ) {
      strongest = behavior;
    }
  }
  return strongest;
}
