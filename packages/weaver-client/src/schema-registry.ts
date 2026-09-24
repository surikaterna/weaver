import {
  type SchemaValidationResult,
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

export function createClientSchemaRegistry(): ClientSchemaRegistry {
  const schemas = new Map<string, ConfigurationPropertySchema>();

  function load(input: Record<string, ConfigurationPropertySchema>): void {
    schemas.clear();
    for (const [key, schema] of Object.entries(input)) schemas.set(key, schema);
  }

  function getRestartRequiredKeys(): ReadonlyArray<string> {
    const keys: string[] = [];
    for (const [key, schema] of schemas) {
      if (schema["x-weaver"]?.reloadBehavior === "restart-required") {
        keys.push(key);
      }
    }
    return keys;
  }

  return {
    load,
    getSchema: (key) => schemas.get(key),
    isSensitive: (key) => schemas.get(key)?.["x-weaver"]?.sensitive === true,
    getReloadBehavior: (key) => schemas.get(key)?.["x-weaver"]?.reloadBehavior,
    getRestartRequiredKeys,
    validate(key, value) {
      const schema = schemas.get(key);
      return schema
        ? validateEffectiveConfiguration(schema, value)
        : { valid: true, errors: [] };
    },
  };
}
