type Snapshot =
  | { readonly success: true; readonly value: unknown }
  | { readonly success: false };

type Work =
  | { readonly leave: true; readonly value: object }
  | {
      readonly leave: false;
      readonly value: unknown;
      readonly assign: (value: unknown) => void;
    };

interface DataField {
  readonly key: string;
  readonly value: unknown;
}

// Capture descriptor values, never re-read caller properties after reflection.
// Proxy reflection may execute traps; uncertain/throwing reflection fails closed.
export function snapshotPlainData(input: unknown): Snapshot {
  try {
    let value: unknown;
    const success = captureGraph(input, (snapshot) => {
      value = snapshot;
    });
    return success ? { success: true, value } : { success: false };
  } catch {
    return { success: false };
  }
}

function captureGraph(
  input: unknown,
  assign: (value: unknown) => void,
): boolean {
  const pending: Work[] = [{ leave: false, value: input, assign }];
  const active = new Set<object>();
  const copies = new Map<object, object>();
  while (pending.length > 0) {
    const work = pending.pop();
    if (!work) continue;
    const { value } = work;
    if (work.leave) {
      active.delete(work.value);
      continue;
    }
    if (value === null || typeof value !== "object") {
      if (!isDataPrimitive(value)) return false;
      work.assign(value);
      continue;
    }
    if (active.has(value)) return false;
    const existing = copies.get(value);
    if (existing) {
      work.assign(existing);
      continue;
    }
    const fields = dataFields(value);
    if (!fields) return false;
    const copy: object = Array.isArray(value) ? [] : Object.create(null);
    copies.set(value, copy);
    active.add(value);
    work.assign(copy);
    pending.push({ leave: true, value });
    scheduleFields(pending, copy, fields);
  }
  return true;
}

function scheduleFields(
  pending: Work[],
  copy: object,
  fields: DataField[],
): void {
  // LIFO traversal must retain source field order for persistence equivalence.
  for (const field of fields.reverse()) {
    pending.push({
      leave: false,
      value: field.value,
      assign: (child) => {
        Object.defineProperty(copy, field.key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      },
    });
  }
}

function isDataPrimitive(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function dataFields(value: object): DataField[] | undefined {
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    return undefined;
  const length = array ? arrayLength(value) : undefined;
  if (array && length === undefined) return undefined;
  const fields: DataField[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (
      typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      return undefined;
    if (
      array &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (length ?? 0))
    )
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    fields.push({ key, value: descriptor.value });
  }
  return array && fields.length !== length ? undefined : fields;
}

function arrayLength(value: object): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    descriptor.enumerable ||
    descriptor.configurable
  )
    return undefined;
  const length: unknown = descriptor.value;
  return typeof length === "number" &&
    Number.isInteger(length) &&
    length >= 0 &&
    length <= 0xffffffff
    ? length
    : undefined;
}
