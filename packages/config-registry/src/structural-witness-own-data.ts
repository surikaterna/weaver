import { createWeaverError } from "@weaver-conf/config-types";

function invalidData(): never {
  throw createWeaverError(
    "VALIDATION_ERROR",
    "Invalid structural witness data",
  );
}

export function ownValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) invalidData();
  const data: unknown = descriptor.value;
  return data;
}

export function ownField<T extends object, K extends keyof T>(
  value: T,
  key: K,
): T[K] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) invalidData();
  // The typed field contract is consumed only after descriptor admission.
  return descriptor.value;
}

export function denseMetadata(values: readonly unknown[]): void {
  if (!Array.isArray(values)) invalidData();
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) invalidData();
  }
}

function stringPath(path: readonly string[]): void {
  if (!Array.isArray(path)) invalidData();
  for (let index = 0; index < path.length; index++) {
    if (typeof ownValue(path, index) !== "string") invalidData();
  }
}

function queueFields(value: object, pending: unknown[]): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    invalidData();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidData();
    if (
      array &&
      key !== "length" &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
    )
      invalidData();
    pending.push(ownValue(value, key));
  }
}

// One own-data pass admits all caller graphs; cycles remain the witness algorithm's concern.
export function preflightWitness(
  schema: object,
  path: readonly string[],
  incoming: unknown,
  candidate: unknown,
  previous: unknown,
): void {
  try {
    stringPath(path);
    const pending: unknown[] = [schema, path, incoming, candidate, previous];
    const seen = new Set<object>();
    while (pending.length) {
      const value: unknown = pending.pop();
      queueValue(value, pending, seen);
    }
  } catch {
    invalidData();
  }
}

function queueValue(
  value: unknown,
  pending: unknown[],
  seen: Set<object>,
): void {
  if (value === null || typeof value !== "object") {
    if (!primitive(value)) invalidData();
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  queueFields(value, pending);
}

function primitive(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}
