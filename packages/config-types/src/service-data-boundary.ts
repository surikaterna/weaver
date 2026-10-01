import { appendDomainValue, type DomainCapture } from "./domain-capture";

interface Visit {
  readonly value: unknown;
  readonly assign: (value: unknown) => void;
  readonly leave?: object;
}

/** Capture all own descriptors before domain parsers read fields. Never freeze a borrower. */
export function captureServiceData(input: unknown): DomainCapture<unknown> {
  try {
    return captureGraph(input);
  } catch {
    return { success: false };
  }
}

function captureGraph(input: unknown): DomainCapture<unknown> {
  let result: unknown;
  const pending: Visit[] = [
    {
      value: input,
      assign: (value) => {
        result = value;
      },
    },
  ];
  const active = new Set<object>();
  const copies = new Map<object, object>();
  while (pending.length) {
    const frame = pending.pop();
    if (!frame) continue;
    if (frame.leave) {
      active.delete(frame.leave);
      Object.freeze(frame.value);
      continue;
    }
    const value = frame.value;
    if (typeof value === "symbol") return { success: false };
    if (value === null || typeof value !== "object") {
      frame.assign(value);
      continue;
    }
    if (active.has(value) || !plainPrototype(value)) return { success: false };
    const existing = copies.get(value);
    if (existing) {
      frame.assign(existing);
      continue;
    }
    const output: object = Array.isArray(value) ? [] : {};
    active.add(value);
    copies.set(value, output);
    frame.assign(output);
    appendDomainValue(pending, {
      value: output,
      assign: frame.assign,
      leave: value,
    });
    if (!scheduleFields(value, output, pending)) return { success: false };
  }
  return { success: true, value: result };
}

function plainPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

function scheduleFields(
  value: object,
  output: object,
  pending: Visit[],
): boolean {
  for (const key of Reflect.ownKeys(value).reverse()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    )
      return false;
    if (Array.isArray(value) && key === "length") {
      Object.defineProperty(output, "length", { value: descriptor.value });
      continue;
    }
    if (
      !descriptor.enumerable ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      return false;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
    const child: unknown = descriptor.value;
    appendDomainValue(pending, {
      value: child,
      assign: (copied) => {
        Object.defineProperty(output, key, { value: copied, enumerable: true });
      },
    });
  }
  return true;
}
