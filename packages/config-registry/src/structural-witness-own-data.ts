import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { createWeaverError } from "@weaver-conf/config-types";

type Schema = ConfigurationPropertySchema;

function invalidData(): never {
  throw createWeaverError(
    "VALIDATION_ERROR",
    "Invalid structural witness data",
  );
}

export function ownValue(value: object, key: PropertyKey): unknown {
  const descriptor = dataDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) return invalidData();
  const data: unknown = descriptor.value;
  return data;
}

export function ownField<T extends object, K extends keyof T>(
  value: T,
  key: K,
): T[K] | undefined {
  const descriptor = dataDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) return invalidData();
  // Preserve the caller's field contract without a Get on its input.
  // Preflight establishes plain data; reflection is not proxy authentication.
  return descriptor.value;
}

export function appendOwn<T>(values: T[], value: T): void {
  Object.defineProperty(values, ownLength(values), {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function* ownValues<T>(values: readonly T[]): Iterable<T> {
  const length = ownLength(values);
  for (let index = 0; index < length; index++) {
    const descriptor = dataDescriptor(values, index);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, "value")) invalidData();
    yield descriptor.value;
  }
}

export function* ownEntries(
  value: object,
): Iterable<readonly [string, unknown]> {
  for (const key of enumerableKeys(value)) yield [key, ownValue(value, key)];
}

export function* schemaEntries(
  value: Readonly<Record<string, Schema>>,
): Iterable<readonly [string, Schema]> {
  for (const key of enumerableKeys(value)) {
    const member = ownField(value, key);
    if (member !== undefined) yield [key, member];
  }
}

export function mapOwn<T, R>(values: Iterable<T>, visit: (value: T) => R): R[] {
  const result: R[] = [];
  for (const value of values) appendOwn(result, visit(value));
  return result;
}

export function filterOwn<T>(
  values: readonly T[],
  accept: (value: T) => boolean,
): T[] {
  const result: T[] = [];
  for (const value of ownValues(values)) {
    if (accept(value)) appendOwn(result, value);
  }
  return result;
}

export function someOwn<T>(
  values: readonly T[],
  accept: (value: T) => boolean,
): boolean {
  for (const value of ownValues(values)) {
    if (accept(value)) return true;
  }
  return false;
}

export function concatOwn<T>(...groups: readonly (readonly T[])[]): T[] {
  const result: T[] = [];
  for (const group of ownValues(groups)) {
    for (const value of ownValues(group)) appendOwn(result, value);
  }
  return result;
}

export function tailOwn<T>(values: readonly T[]): T[] {
  const result: T[] = [];
  const length = ownLength(values);
  for (let index = 1; index < length; index++) {
    const descriptor = dataDescriptor(values, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalidData();
    appendOwn(result, descriptor.value);
  }
  return result;
}

function ownLength(value: readonly unknown[]): number {
  const length = ownValue(value, "length");
  if (typeof length !== "number" || !Number.isInteger(length)) invalidData();
  if (length < 0 || length > 0xffff_ffff) invalidData();
  return length;
}

function dataDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return invalidData();
  }
}

function enumerableKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return invalidData();
  }
}

function denseArray(value: readonly unknown[]): void {
  const length = ownLength(value);
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) invalidData();
  }
}

function stringPath(path: readonly string[]): void {
  if (!Array.isArray(path)) invalidData();
  const length = ownLength(path);
  for (let index = 0; index < length; index++) {
    const descriptor = dataDescriptor(path, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalidData();
    const segment: unknown = descriptor.value;
    if (typeof segment !== "string") invalidData();
  }
}

function plainContainer(value: object): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) invalidData();
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) invalidData();
}

function primitive(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function queueFields(value: object, pending: unknown[]): void {
  const array = Array.isArray(value);
  const length = array ? ownValue(value, "length") : undefined;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidData();
    const data = ownValue(value, key);
    if (array && key !== "length") {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) invalidData();
      if (typeof length !== "number" || Number(key) >= length) invalidData();
    }
    appendOwn(pending, data);
  }
}

function preflightGraph(roots: readonly unknown[]): void {
  const pending = concatOwn(roots);
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value: unknown = pending.pop();
    if (value === null || typeof value !== "object") {
      if (!primitive(value)) invalidData();
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    plainContainer(value);
    queueFields(value, pending);
  }
}

function queueSchemas(schema: Schema, pending: Schema[]): void {
  const type = ownField(schema, "type");
  if (Array.isArray(type)) denseArray(type);
  const compositions: readonly ("allOf" | "anyOf" | "oneOf")[] = [
    "allOf",
    "anyOf",
    "oneOf",
  ];
  for (const key of compositions) {
    const branches = ownField(schema, key);
    if (!branches) continue;
    denseArray(branches);
    for (const branch of ownValues(branches)) appendOwn(pending, branch);
  }
  const maps: readonly ("properties" | "patternProperties")[] = [
    "properties",
    "patternProperties",
  ];
  for (const key of maps) {
    const members = ownField(schema, key);
    if (!members) continue;
    for (const [, member] of schemaEntries(members)) appendOwn(pending, member);
  }
  const items = ownField(schema, "items");
  if (Array.isArray(items)) {
    for (const member of ownValues(items)) appendOwn(pending, member);
  } else if (items && typeof items === "object") appendOwn(pending, items);
  const additional = ownField(schema, "additionalProperties");
  if (additional && typeof additional === "object")
    appendOwn(pending, additional);
  const not = ownField(schema, "not");
  if (not) appendOwn(pending, not);
}

function preflightSchemas(schema: Schema): void {
  const pending: Schema[] = [schema];
  const seen = new Set<Schema>();
  while (pending.length > 0) {
    const member = pending.pop();
    if (!member || seen.has(member)) continue;
    seen.add(member);
    queueSchemas(member, pending);
  }
}

export function preflightWitness(
  schema: Schema,
  path: readonly string[],
  incoming: unknown,
  candidate: unknown,
  previous: unknown,
): void {
  try {
    stringPath(path);
    preflightGraph([schema, path, incoming, candidate, previous]);
    preflightSchemas(schema);
  } catch {
    invalidData();
  }
}
