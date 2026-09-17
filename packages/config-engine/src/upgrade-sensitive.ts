import {
  type ConfigurationPropertySchema,
  containsRegistrationDefaultMarker,
} from "@weaver-conf/config-types";

export function containsSensitiveValue(
  schema: ConfigurationPropertySchema | undefined,
  value: unknown,
): boolean {
  if (containsRegistrationDefaultMarker(value)) return true;
  if (value === undefined) return false;
  if (!schema) return true;
  if (schema["x-weaver"]?.sensitive) return true;
  if (Array.isArray(value)) return sensitiveArray(schema, value);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const members = memberSchemas(schema, key);
    return (
      members.length === 0 ||
      members.some((member) => containsSensitiveValue(member, child))
    );
  });
}

function sensitiveArray(
  schema: ConfigurationPropertySchema,
  value: readonly unknown[],
): boolean {
  const items = schema.items;
  if (!items) return value.length > 0;
  if (isSchemaTuple(items))
    return value.some((item, index) =>
      containsSensitiveValue(items[index], item),
    );
  return value.some((item) => containsSensitiveValue(items, item));
}

function isSchemaTuple(
  items: ConfigurationPropertySchema["items"],
): items is readonly ConfigurationPropertySchema[] {
  return Array.isArray(items);
}

function memberSchemas(
  schema: ConfigurationPropertySchema,
  key: string,
): readonly ConfigurationPropertySchema[] {
  const result: ConfigurationPropertySchema[] = [];
  const named = schema.properties?.[key];
  if (named) result.push(named);
  for (const [pattern, child] of Object.entries(schema.patternProperties ?? {}))
    if (new RegExp(pattern).test(key)) result.push(child);
  if (!result.length) {
    const additional = schema.additionalProperties;
    if (typeof additional === "object") result.push(additional);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
