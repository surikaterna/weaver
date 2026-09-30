import { z } from "zod";

/** Inspect descriptors before Zod reads fields; never invoke an input accessor. */
export function serviceDataBoundary<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .superRefine((input, context) => {
      if (!isPlainServiceData(input)) {
        context.addIssue({
          code: "custom",
          message: "Expected plain service data",
        });
      }
    })
    .pipe(schema);
}

function isPlainServiceData(input: unknown): boolean {
  const pending: { value: unknown; leave?: boolean }[] = [{ value: input }];
  const active = new Set<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const { value } = entry;
    if (typeof value === "symbol") return false;
    if (value === null || typeof value !== "object") continue;
    if (entry.leave) {
      active.delete(value);
      continue;
    }
    if (active.has(value)) return false;
    active.add(value);
    if (!hasPlainPrototype(value)) return false;
    const children = dataChildren(value);
    if (children === undefined) return false;
    pending.push({ value, leave: true });
    for (const child of children) pending.push({ value: child });
  }
  return true;
}

function hasPlainPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

function dataChildren(value: object): unknown[] | undefined {
  const children: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    if (
      typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      return undefined;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    children.push(descriptor.value);
  }
  return children;
}
