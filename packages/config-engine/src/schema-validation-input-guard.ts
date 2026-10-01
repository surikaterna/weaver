import { pushOwn } from "./own-data";

export interface ValidationDataInspection {
  readonly safe: boolean;
  readonly cyclic: boolean;
}

type GuardFrame =
  | { readonly kind: "enter"; readonly value: unknown }
  | { readonly kind: "exit"; readonly value: object };

// Descriptor safety is separate from schema semantics and cycle diagnostics.
// Identity-based active/completed sets admit shared DAGs without depth limits.
export function inspectValidationData(
  value: unknown,
): ValidationDataInspection {
  const pending: GuardFrame[] = [{ kind: "enter", value }];
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  let cyclic = false;
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined) continue;
      if (frame.kind === "exit") {
        active.delete(frame.value);
        completed.add(frame.value);
        continue;
      }
      const target = frame.value;
      if (!isDataPrimitive(target) && typeof target !== "object")
        return { safe: false, cyclic };
      if (typeof target !== "object" || target === null) continue;
      if (active.has(target)) {
        cyclic = true;
        continue;
      }
      if (completed.has(target)) continue;
      if (!hasDataPrototype(target)) return { safe: false, cyclic };
      active.add(target);
      pushOwn(pending, { kind: "exit", value: target });
      if (!queueDataDescriptors(target, pending))
        return { safe: false, cyclic };
    }
    return { safe: true, cyclic };
  } catch {
    return { safe: false, cyclic };
  }
}

function isDataPrimitive(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function hasDataPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

function queueDataDescriptors(value: object, pending: GuardFrame[]): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    if (Array.isArray(value) && !isArrayDataKey(key, value.length))
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      return false;
    const child: unknown = descriptor.value;
    pushOwn(pending, { kind: "enter", value: child });
  }
  return true;
}

function isArrayDataKey(key: string, length: number): boolean {
  if (key === "length") return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}
