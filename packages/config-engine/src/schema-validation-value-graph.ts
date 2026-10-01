import {
  addContextError,
  appendValidationPath,
  type SchemaValidationPathSegment,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

type ValueFrame =
  | {
      readonly kind: "enter";
      readonly value: unknown;
      readonly path: ValidationPath;
    }
  | { readonly kind: "exit"; readonly value: object };

interface ValueTraversal {
  readonly active: WeakSet<object>;
  readonly completed: WeakSet<object>;
  readonly pending: ValueFrame[];
}

// One descriptor/cycle pass admits caller values before semantic validation reads them.
export function validateValueGraph(
  value: unknown,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  const traversal: ValueTraversal = {
    active: new WeakSet(),
    completed: new WeakSet(),
    pending: [{ kind: "enter", value, path }],
  };
  try {
    while (traversal.pending.length) {
      const frame = traversal.pending.pop();
      if (!frame) continue;
      if (frame.kind === "exit") {
        traversal.active.delete(frame.value);
        traversal.completed.add(frame.value);
        continue;
      }
      if (enterValue(frame, traversal, context)) continue;
      return false;
    }
    return true;
  } catch {
    return invalidValue(context, path);
  }
}

function enterValue(
  frame: Extract<ValueFrame, { kind: "enter" }>,
  traversal: ValueTraversal,
  context: ValidationContext,
): boolean {
  const { value, path } = frame;
  if (value === null || typeof value !== "object") {
    return ["undefined", "string", "number", "boolean"].includes(
      typeof value,
    ) || value === null
      ? true
      : invalidValue(context, path);
  }
  if (!plainContainer(value)) return invalidValue(context, path);
  if (traversal.active.has(value)) {
    addContextError(context, "invalid-value", path, {
      message: "Configuration values must not contain cycles",
    });
    return false;
  }
  if (traversal.completed.has(value)) return true;
  traversal.active.add(value);
  traversal.pending.push({ kind: "exit", value });
  return (
    queueDescriptors(value, path, traversal.pending) ||
    invalidValue(context, path)
  );
}

function queueDescriptors(
  value: object,
  path: ValidationPath,
  pending: ValueFrame[],
): boolean {
  for (const key of Reflect.ownKeys(value).reverse()) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
    if (Array.isArray(value)) {
      if (key === "length") continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
        return false;
    }
    const child: unknown = descriptor.value;
    pending.push({
      kind: "enter",
      value: child,
      path: appendValidationPath(path, valuePathSegment(value, key)),
    });
  }
  return true;
}

function plainContainer(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

function invalidValue(context: ValidationContext, path: ValidationPath): false {
  addContextError(context, "invalid-value", path, {
    message: "Configuration values must contain only own plain data",
  });
  return false;
}

function valuePathSegment(
  parent: object,
  key: string,
): SchemaValidationPathSegment {
  if (!Array.isArray(parent) || !/^(0|[1-9][0-9]*)$/.test(key)) return key;
  const index = Number(key);
  return Number.isSafeInteger(index) && index <= 4_294_967_294 ? index : key;
}
