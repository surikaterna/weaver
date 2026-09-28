interface VisitFrame {
  readonly kind: "visit";
  readonly path: string;
  readonly value: unknown;
}

type SerializationFrame =
  | { readonly kind: "emit"; readonly value: string }
  | { readonly kind: "leave"; readonly value: object }
  | VisitFrame;

export function serializeHttpJsonValue(value: unknown): string {
  const active = new Set<object>();
  const chunks: string[] = [];
  const stack: SerializationFrame[] = [{ kind: "visit", path: "$", value }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    if (frame.kind === "emit") chunks.push(frame.value);
    else if (frame.kind === "leave") active.delete(frame.value);
    else visitValue(frame, active, stack, chunks);
  }
  return chunks.join("");
}

function visitValue(
  frame: VisitFrame,
  active: Set<object>,
  stack: SerializationFrame[],
  chunks: string[],
): void {
  const { path, value } = frame;
  const primitive = encodePrimitive(value, path);
  if (primitive !== undefined) {
    chunks.push(primitive);
    return;
  }
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${path} is not representable as JSON`);
  }
  if (active.has(value)) throw new TypeError(`${path} contains a cycle`);
  if (Array.isArray(value)) {
    active.add(value);
    stack.push({ kind: "leave", value }, { kind: "emit", value: "]" });
    chunks.push("[");
    scheduleArray(value, path, stack);
    return;
  }
  active.add(value);
  stack.push({ kind: "leave", value }, { kind: "emit", value: "}" });
  chunks.push("{");
  scheduleRecord(value, path, stack);
}

function encodePrimitive(value: unknown, path: string): string | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return encodeScalar(value);
  if (typeof value !== "number") return undefined;
  validateNumber(value, path);
  return encodeScalar(value);
}

function validateNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} contains a non-finite number`);
  }
  if (Object.is(value, -0)) {
    throw new TypeError(`${path} contains negative zero`);
  }
}

function encodeScalar(value: number | string): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw new TypeError("Invalid JSON scalar");
  return encoded;
}

function scheduleArray(
  value: unknown[],
  path: string,
  stack: SerializationFrame[],
): void {
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
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (!child) continue;
    stack.push(child);
    if (index > 0) stack.push({ kind: "emit", value: "," });
  }
}

function scheduleRecord(
  value: object,
  path: string,
  stack: SerializationFrame[],
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new TypeError(`${path} has a custom object prototype`);
  }
  const entries: Array<{ key: string; frame: VisitFrame }> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} has a symbol property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} is not an enumerable data value`);
    }
    entries.push({
      key,
      frame: { kind: "visit", path: `${path}.${key}`, value: descriptor.value },
    });
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    stack.push(entry.frame);
    stack.push({ kind: "emit", value: ":" });
    stack.push({ kind: "emit", value: encodeScalar(entry.key) });
    if (index > 0) stack.push({ kind: "emit", value: "," });
  }
}
