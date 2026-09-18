import type { PropertySessionMode } from "./session";
import type { ConfigurationLayer } from "./types";

/** Promotion pipeline stage required before a config change takes effect. */
export type ConfigChangePolicy =
  | "full-pipeline"
  | "staging-gate"
  | "direct-allowed"
  | "emergency-override";

/** Who can see a configuration property in admin UIs. */
export type ConfigurationVisibility =
  | "public"
  | "admin"
  | "platform"
  | "internal";

/** Role identifier for access control (opaque string). */
export type ConfigurationRole = string;

/** How a service must handle a configuration value change at runtime. */
export type ConfigReloadBehavior =
  | "hot"
  | "restart-required"
  | "rolling-restart";

/** JSON Schema primitive type identifiers. */
export type ConfigurationJsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** JSON Schema subset used to describe configuration properties with Weaver extensions. */
export interface ConfigurationPropertySchema {
  type:
    | ConfigurationJsonSchemaType
    | ReadonlyArray<ConfigurationJsonSchemaType>;
  title?: string | undefined;
  default?: unknown;
  description?: string | undefined;
  examples?: ReadonlyArray<unknown> | undefined;
  const?: unknown;
  enum?: ReadonlyArray<unknown> | undefined;
  format?: string | undefined;
  pattern?: string | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  multipleOf?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  exclusiveMaximum?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  uniqueItems?: boolean | undefined;
  minProperties?: number | undefined;
  maxProperties?: number | undefined;
  required?: ReadonlyArray<string> | undefined;
  properties?:
    | Readonly<Record<string, ConfigurationPropertySchema>>
    | undefined;
  patternProperties?:
    | Readonly<Record<string, ConfigurationPropertySchema>>
    | undefined;
  additionalProperties?: boolean | ConfigurationPropertySchema | undefined;
  items?:
    | ConfigurationPropertySchema
    | ReadonlyArray<ConfigurationPropertySchema>
    | undefined;
  oneOf?: ReadonlyArray<ConfigurationPropertySchema> | undefined;
  anyOf?: ReadonlyArray<ConfigurationPropertySchema> | undefined;
  allOf?: ReadonlyArray<ConfigurationPropertySchema> | undefined;
  not?: ConfigurationPropertySchema | undefined;

  // Unsupported by policy: schema must remain self-contained.
  $ref?: undefined;
  $defs?: undefined;

  "x-weaver"?: WeaverPropertyExtensions | undefined;
}

/** Configuration schema whose root is unambiguously an object. */
export interface ObjectConfigurationPropertySchema
  extends ConfigurationPropertySchema {
  readonly type: "object";
}

/** Weaver-specific property extensions (sensitivity, change policy, reload behavior). */
export interface WeaverPropertyExtensions {
  sensitive?: boolean | undefined;
  visibility?: ConfigurationVisibility | undefined;
  changePolicy?: ConfigChangePolicy | undefined;
  reloadBehavior?: ConfigReloadBehavior | undefined;
  expressionAllowed?: boolean | undefined;
  maxOverrideLayer?: ConfigurationLayer | undefined;
  writeRestriction?: ReadonlyArray<ConfigurationRole> | undefined;
  sessionMode?: PropertySessionMode | undefined;
}
