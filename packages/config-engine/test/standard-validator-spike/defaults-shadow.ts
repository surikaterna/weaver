import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

interface ShadowFrame {
  readonly schema: ConfigurationPropertySchema;
  readonly source: Record<string, unknown> | readonly unknown[];
  readonly target: Record<string, unknown> | unknown[];
}

export function effectiveShadow(
  schema: ConfigurationPropertySchema,
  value: unknown,
): unknown {
  if (value === undefined && schema.default !== undefined)
    return cloneJsonGraph(schema.default);
  if (!isContainer(value)) return value;
  const root = emptyContainer(value);
  const pending: ShadowFrame[] = [{ schema, source: value, target: root }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    copyPresentMembers(frame, pending);
    if (!Array.isArray(frame.source)) applyAbsentDefaults(frame, pending);
  }
  return root;
}

function copyPresentMembers(frame: ShadowFrame, pending: ShadowFrame[]): void {
  for (const key of Object.keys(frame.source)) {
    const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const childSchema = schemaForMember(frame.schema, key);
    const shadow = shadowChild(childSchema, descriptor.value, pending);
    defineOwn(frame.target, key, shadow);
  }
}

function applyAbsentDefaults(frame: ShadowFrame, pending: ShadowFrame[]): void {
  for (const key of frame.schema.required ?? []) {
    if (Object.hasOwn(frame.source, key)) continue;
    const child = ownPropertySchema(frame.schema, key);
    if (child?.default === undefined) continue;
    defineOwn(frame.target, key, shadowChild(child, child.default, pending));
  }
}

function shadowChild(
  schema: ConfigurationPropertySchema | undefined,
  value: unknown,
  pending: ShadowFrame[],
): unknown {
  if (!isContainer(value)) return value;
  const target = emptyContainer(value);
  pending.push({ schema: schema ?? openSchema(value), source: value, target });
  return target;
}

function schemaForMember(
  schema: ConfigurationPropertySchema,
  key: string,
): ConfigurationPropertySchema | undefined {
  if (isSchemaArray(schema.items)) return schema.items[Number(key)];
  if (schema.items !== undefined) return schema.items;
  return ownPropertySchema(schema, key);
}

function isSchemaArray(
  value:
    | ConfigurationPropertySchema
    | readonly ConfigurationPropertySchema[]
    | undefined,
): value is readonly ConfigurationPropertySchema[] {
  return Array.isArray(value);
}

function ownPropertySchema(
  schema: ConfigurationPropertySchema,
  key: string,
): ConfigurationPropertySchema | undefined {
  const properties = schema.properties;
  return properties !== undefined && Object.hasOwn(properties, key)
    ? properties[key]
    : undefined;
}

function cloneJsonGraph(value: unknown): unknown {
  if (!isContainer(value)) return value;
  const root = emptyContainer(value);
  const pending: ShadowFrame[] = [
    { schema: openSchema(value), source: value, target: root },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame !== undefined) copyPresentMembers(frame, pending);
  }
  return root;
}

function emptyContainer(
  value: Record<string, unknown> | readonly unknown[],
): Record<string, unknown> | unknown[] {
  return Array.isArray(value) ? new Array<unknown>(value.length) : {};
}

function openSchema(
  value: Record<string, unknown> | readonly unknown[],
): ConfigurationPropertySchema {
  return Array.isArray(value)
    ? { type: "array" }
    : { type: "object", additionalProperties: true };
}

function isContainer(
  value: unknown,
): value is Record<string, unknown> | readonly unknown[] {
  return typeof value === "object" && value !== null;
}

function defineOwn(
  target: Record<string, unknown> | unknown[],
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
