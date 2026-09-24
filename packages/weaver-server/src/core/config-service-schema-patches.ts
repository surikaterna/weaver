import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

const MAX_ARRAY_INDEX = 4_294_967_294;

export type SchemaPatchResult =
  | { readonly success: true; readonly value: unknown }
  | {
      readonly success: false;
      readonly reason: "invalid-array-index";
      readonly segment: string;
    }
  | {
      readonly success: false;
      readonly reason: "array-index-out-of-range";
      readonly index: number;
      readonly length: number;
    }
  | {
      readonly success: false;
      readonly reason: "invalid-container";
      readonly segment: string;
    };

export function buildSchemaPatch(
  baseValue: unknown,
  segments: readonly string[],
  value: unknown,
  schema: ConfigurationPropertySchema | undefined,
): SchemaPatchResult {
  const root = baseValue === undefined ? {} : clonePatchValue(baseValue);
  let current: unknown = root;
  let schemas = schema === undefined ? undefined : [schema];
  for (let position = 0; position < segments.length; position++) {
    const segment = segments[position];
    if (segment === undefined) continue;
    const final = position === segments.length - 1;
    schemas = resolvePatchMemberSchemas(schemas, segment);
    const result = Array.isArray(current)
      ? patchArray(current, segment, schemas, value, final)
      : patchObject(current, segment, schemas, value, final);
    if (!result.success) return result;
    current = result.next;
  }
  return { success: true, value: root };
}

type CloneContainer = Record<string, unknown> | unknown[];

interface CloneFrame {
  readonly source: object;
  readonly target: CloneContainer;
}

function clonePatchValue(value: unknown): unknown {
  if (!isObject(value)) return value;
  const root = emptyClone(value);
  const clones = new WeakMap<object, CloneContainer>([[value, root]]);
  const pending = new Set<CloneFrame>([{ source: value, target: root }]);
  while (pending.size > 0) {
    const entry = pending.values().next();
    if (entry.done) continue;
    const frame = entry.value;
    pending.delete(frame);
    for (const [key, member] of Object.entries(frame.source)) {
      const cloned = cloneMember(member, clones, pending);
      defineOwnDataProperty(frame.target, key, cloned);
    }
  }
  return root;
}

function cloneMember(
  value: unknown,
  clones: WeakMap<object, CloneContainer>,
  pending: Set<CloneFrame>,
): unknown {
  if (!isObject(value)) return value;
  const existing = clones.get(value);
  if (existing !== undefined) return existing;
  const clone = emptyClone(value);
  clones.set(value, clone);
  pending.add({ source: value, target: clone });
  return clone;
}

function emptyClone(value: object): CloneContainer {
  return Array.isArray(value) ? new Array<unknown>(value.length) : {};
}

type StepResult =
  | { readonly success: true; readonly next: unknown }
  | Exclude<SchemaPatchResult, { readonly success: true }>;

function patchArray(
  current: unknown[],
  segment: string,
  schemas: readonly ConfigurationPropertySchema[] | undefined,
  value: unknown,
  final: boolean,
): StepResult {
  const index = parseArrayIndex(segment);
  if (index === undefined) {
    return { success: false, reason: "invalid-array-index", segment };
  }
  if (index > current.length) {
    return {
      success: false,
      reason: "array-index-out-of-range",
      index,
      length: current.length,
    };
  }
  if (final) return defineOwnArrayIndex(current, index, segment, value);
  const existing = Object.hasOwn(current, String(index))
    ? current[index]
    : undefined;
  const next = existing ?? createContainer(schemas);
  return defineOwnArrayIndex(current, index, segment, next);
}

function defineOwnArrayIndex(
  current: unknown[],
  index: number,
  segment: string,
  value: unknown,
): StepResult {
  try {
    const defined = Reflect.defineProperty(current, String(index), {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return defined
      ? { success: true, next: value }
      : { success: false, reason: "invalid-container", segment };
  } catch {
    return { success: false, reason: "invalid-container", segment };
  }
}

function patchObject(
  current: unknown,
  segment: string,
  schemas: readonly ConfigurationPropertySchema[] | undefined,
  value: unknown,
  final: boolean,
): StepResult {
  if (!isRecord(current)) {
    return { success: false, reason: "invalid-container", segment };
  }
  if (final) {
    defineOwnDataProperty(current, segment, value);
    return { success: true, next: value };
  }
  const existing = Object.hasOwn(current, segment)
    ? current[segment]
    : undefined;
  const next =
    isRecord(existing) || Array.isArray(existing)
      ? existing
      : createContainer(schemas);
  defineOwnDataProperty(current, segment, next);
  return { success: true, next };
}

function createContainer(
  schemas: readonly ConfigurationPropertySchema[] | undefined,
): unknown[] | Record<string, unknown> {
  if (schemas === undefined || schemas.length === 0) return {};
  const projected: ConfigurationPropertySchema[] = [];
  for (let index = 0; index < schemas.length; index++) {
    if (!Object.hasOwn(schemas, index)) continue;
    const schema = schemas[index];
    if (schema === undefined) continue;
    for (const candidate of directAndAllOfSchemas(schema)) {
      appendSchema(projected, candidate);
    }
  }
  const allowsArray = projected.every((schema) => allowsType(schema, "array"));
  const allowsObject = projected.every((schema) =>
    allowsType(schema, "object"),
  );
  return allowsArray && !allowsObject ? [] : {};
}

function resolvePatchMemberSchemas(
  schemas: readonly ConfigurationPropertySchema[] | undefined,
  segment: string,
): ConfigurationPropertySchema[] | undefined {
  if (schemas === undefined) return undefined;
  const resolved: ConfigurationPropertySchema[] = [];
  for (let index = 0; index < schemas.length; index++) {
    if (!Object.hasOwn(schemas, index)) continue;
    const schema = schemas[index];
    if (schema === undefined) continue;
    for (const projected of directAndAllOfSchemas(schema)) {
      for (const member of directPatchMemberSchemas(projected, segment)) {
        appendSchema(resolved, member);
      }
    }
  }
  return resolved;
}

function directPatchMemberSchemas(
  schema: ConfigurationPropertySchema,
  segment: string,
): ConfigurationPropertySchema[] {
  if (allowsType(schema, "object")) return objectMemberSchemas(schema, segment);
  if (!allowsType(schema, "array")) return [];
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  if (items === undefined) return [];
  if (!isSchemaArray(items)) return [items];
  const item = items[Number(segment)];
  return item === undefined ? [] : [item];
}

function directAndAllOfSchemas(
  schema: ConfigurationPropertySchema,
): readonly ConfigurationPropertySchema[] {
  const projected: ConfigurationPropertySchema[] = [];
  const pending = [schema];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    appendSchema(projected, current);
    const branches = Object.hasOwn(current, "allOf")
      ? current.allOf
      : undefined;
    if (!Array.isArray(branches)) continue;
    for (let index = branches.length - 1; index >= 0; index--) {
      if (!Object.hasOwn(branches, index)) continue;
      const branch = branches[index];
      if (branch !== undefined) appendSchema(pending, branch);
    }
  }
  return projected;
}

function appendSchema(
  target: ConfigurationPropertySchema[],
  schema: ConfigurationPropertySchema,
): void {
  Reflect.defineProperty(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value: schema,
    writable: true,
  });
}

function objectMemberSchemas(
  schema: ConfigurationPropertySchema,
  key: string,
): ConfigurationPropertySchema[] {
  const properties = Object.hasOwn(schema, "properties")
    ? schema.properties
    : undefined;
  const declared =
    properties !== undefined && Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
  const patterns = Object.hasOwn(schema, "patternProperties")
    ? schema.patternProperties
    : undefined;
  const schemas: ConfigurationPropertySchema[] = [];
  for (const [pattern, memberSchema] of Object.entries(patterns ?? {})) {
    if (new RegExp(pattern).test(key)) appendSchema(schemas, memberSchema);
  }
  if (declared !== undefined) return [declared, ...schemas];
  if (schemas.length > 0) return schemas;
  const additional = Object.hasOwn(schema, "additionalProperties")
    ? schema.additionalProperties
    : undefined;
  return additional !== null && typeof additional === "object"
    ? [additional]
    : [];
}

function allowsType(
  schema: ConfigurationPropertySchema,
  type: "array" | "object",
): boolean {
  return Array.isArray(schema.type)
    ? schema.type.includes(type)
    : schema.type === type;
}

function isSchemaArray(
  value: ConfigurationPropertySchema | readonly ConfigurationPropertySchema[],
): value is readonly ConfigurationPropertySchema[] {
  return Array.isArray(value);
}

function defineOwnDataProperty(
  target: CloneContainer,
  key: string,
  value: unknown,
): void {
  Reflect.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function parseArrayIndex(segment: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) && index <= MAX_ARRAY_INDEX
    ? index
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
