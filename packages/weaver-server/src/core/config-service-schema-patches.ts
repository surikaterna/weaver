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
  const pending: CloneFrame[] = [{ source: value, target: root }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
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
  pending: CloneFrame[],
): unknown {
  if (!isObject(value)) return value;
  const existing = clones.get(value);
  if (existing !== undefined) return existing;
  const clone = emptyClone(value);
  clones.set(value, clone);
  pending.push({ source: value, target: clone });
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
  if (final) {
    if (index === current.length) current.push(value);
    else current[index] = value;
    return { success: true, next: value };
  }
  const next = current[index] ?? createContainer(schemas);
  if (index === current.length) current.push(next);
  else current[index] = next;
  return { success: true, next };
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
  return schemas?.length !== 0 && schemas?.every(allowsArrayOnly) === true
    ? []
    : {};
}

function resolvePatchMemberSchemas(
  schemas: readonly ConfigurationPropertySchema[] | undefined,
  segment: string,
): ConfigurationPropertySchema[] | undefined {
  if (schemas === undefined) return undefined;
  return schemas.flatMap((schema) => {
    if (allowsType(schema, "object"))
      return objectMemberSchemas(schema, segment);
    if (!allowsType(schema, "array")) return [];
    const items = schema.items;
    if (items === undefined) return [];
    if (!Array.isArray(items)) return [items];
    const item = items[Number(segment)];
    return item === undefined ? [] : [item];
  });
}

function objectMemberSchemas(
  schema: ConfigurationPropertySchema,
  key: string,
): ConfigurationPropertySchema[] {
  const schemas: ConfigurationPropertySchema[] = [];
  const declared = schema.properties?.[key];
  if (declared !== undefined) schemas.push(declared);
  for (const [pattern, memberSchema] of Object.entries(
    schema.patternProperties ?? {},
  )) {
    if (new RegExp(pattern).test(key)) schemas.push(memberSchema);
  }
  if (schemas.length > 0) return schemas;
  const additional = schema.additionalProperties;
  return additional !== null && typeof additional === "object"
    ? [additional]
    : [];
}

function allowsArrayOnly(schema: ConfigurationPropertySchema): boolean {
  return allowsType(schema, "array") && !allowsType(schema, "object");
}

function allowsType(
  schema: ConfigurationPropertySchema,
  type: "array" | "object",
): boolean {
  return Array.isArray(schema.type)
    ? schema.type.includes(type)
    : schema.type === type;
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
