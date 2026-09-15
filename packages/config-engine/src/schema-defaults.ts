import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { getSafeSchemaRegex } from "./regex-cache";
import { isRecord, isSchemaArray } from "./schema-validation-support";

/** Returns an isolated value; only absent own properties receive defaults. */
export function materializeConfigurationDefaults(
  schema: ConfigurationPropertySchema,
  value: unknown,
  absent = value === undefined,
): unknown {
  return materializeConfigurationDefaultsForSchemas([schema], value, absent);
}

/** Governing schemas share one traversal, including defaults below parents introduced by another schema. */
export function materializeConfigurationDefaultsForSchemas(
  schemas: readonly ConfigurationPropertySchema[],
  value: unknown,
  absent = value === undefined,
): unknown {
  const clone: unknown = structuredClone(value);
  return fillDefaults(schemas, clone, absent);
}

function fillDefaults(
  schemas: readonly ConfigurationPropertySchema[],
  value: unknown,
  absent: boolean,
): unknown {
  const defaultSchema = absent
    ? schemas.find((schema) => Object.hasOwn(schema, "default"))
    : undefined;
  const result: unknown = defaultSchema
    ? structuredClone(defaultSchema.default)
    : value;
  if (Array.isArray(result)) return fillArray(schemas, result);
  if (!isRecord(result)) return result;
  const keys = new Set([
    ...Object.keys(result),
    ...schemas.flatMap((schema) => Object.keys(schema.properties ?? {})),
  ]);
  for (const key of keys) {
    const missing = !Object.hasOwn(result, key);
    const children = schemas.flatMap((schema) => memberSchemas(schema, key));
    const filled = fillDefaults(children, result[key], missing);
    if (!missing || filled !== undefined) defineValue(result, key, filled);
  }
  return result;
}

function fillArray(
  schemas: readonly ConfigurationPropertySchema[],
  value: unknown[],
): unknown[] {
  return value.map((item: unknown, index) => {
    const children = schemas.flatMap((schema) => {
      const items = schema.items;
      const child = items && (isSchemaArray(items) ? items[index] : items);
      return child ? [child] : [];
    });
    return fillDefaults(children, item, false);
  });
}

function memberSchemas(
  schema: ConfigurationPropertySchema,
  key: string,
): ConfigurationPropertySchema[] {
  const declared = Object.hasOwn(schema.properties ?? {}, key)
    ? schema.properties?.[key]
    : undefined;
  const matching = Object.entries(schema.patternProperties ?? {})
    .filter(([pattern]) => getSafeSchemaRegex(pattern).test(key))
    .map(([, child]) => child);
  if (declared) matching.unshift(declared);
  const additional = schema.additionalProperties;
  if (matching.length === 0 && typeof additional === "object") {
    matching.push(additional);
  }
  return matching;
}

function defineValue(
  value: Record<string, unknown>,
  key: string,
  child: unknown,
): void {
  Object.defineProperty(value, key, {
    value: child,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
