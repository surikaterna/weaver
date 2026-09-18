interface VisitFrame {
  readonly kind: "visit";
  readonly path: string;
  readonly value: unknown;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly value: object;
}

type ValidationFrame = LeaveFrame | VisitFrame;

export function serializeHttpJsonValue(value: unknown): string {
  validateHttpJsonValue(value);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new TypeError("HTTP body is not representable as JSON");
  }
  return serialized;
}

function validateHttpJsonValue(value: unknown): void {
  const active = new Set<object>();
  const stack: ValidationFrame[] = [{ kind: "visit", path: "$", value }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }
    visitValue(frame, active, stack);
  }
}

function visitValue(
  frame: VisitFrame,
  active: Set<object>,
  stack: ValidationFrame[],
): void {
  const { path, value } = frame;
  if (isJsonPrimitive(value)) return;
  if (typeof value === "number") {
    validateNumber(value, path);
    return;
  }
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${path} is not representable as JSON`);
  }
  if (active.has(value)) throw new TypeError(`${path} contains a cycle`);
  const children = Array.isArray(value)
    ? inspectArray(value, path)
    : inspectRecord(value, path);
  active.add(value);
  stack.push({ kind: "leave", value });
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child) stack.push(child);
  }
}

function isJsonPrimitive(value: unknown): boolean {
  return (
    value === null || typeof value === "boolean" || typeof value === "string"
  );
}

function validateNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} contains a non-finite number`);
  }
  if (Object.is(value, -0)) {
    throw new TypeError(`${path} contains negative zero`);
  }
}

function inspectArray(value: unknown[], path: string): VisitFrame[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} has a custom array prototype`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    throw new TypeError(`${path} is sparse or has extra properties`);
  }
  const children: VisitFrame[] = [];
  for (let index = 0; index < value.length; index++) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}[${index}] is not an enumerable data value`);
    }
    children.push({
      kind: "visit",
      path: `${path}[${index}]`,
      value: descriptor.value,
    });
  }
  if (
    keys.some((key) => key !== "length" && !isArrayIndex(key, value.length))
  ) {
    throw new TypeError(`${path} has extra array properties`);
  }
  return children;
}

function isArrayIndex(key: PropertyKey, length: number): boolean {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function inspectRecord(value: object, path: string): VisitFrame[] {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new TypeError(`${path} has a custom object prototype`);
  }
  const children: VisitFrame[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} has a symbol property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} is not an enumerable data value`);
    }
    children.push({
      kind: "visit",
      path: `${path}.${key}`,
      value: descriptor.value,
    });
  }
  return children;
}
