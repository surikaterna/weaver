import { pushOwn } from "./own-data";

// Reflection preserves the declared field type without a Get on the input.
// Callers establish plain-data safety before treating fields as schema contracts.
export function ownField<T extends object, K extends keyof T>(
  target: T,
  key: K,
): T[K] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

export function ownEntries<T>(
  value: Readonly<Record<string, T>>,
): [string, T][];
export function ownEntries(value: object): [string, unknown][];
export function ownEntries(value: object): [string, unknown][] {
  const entries: [string, unknown][] = [];
  const target: object = Object(value);
  for (const key of Object.keys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      continue;
    pushOwn(entries, [key, descriptor.value]);
  }
  return entries;
}

export function appendOwn<T>(target: T[], values: readonly T[]): void {
  for (const value of values) pushOwn(target, value);
}
