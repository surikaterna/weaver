import { pushOwn } from "./own-data";

export interface ValidationDataInspection {
  readonly safe: boolean;
  readonly cyclic: boolean;
}

type GuardFrame =
  | { readonly kind: "enter"; readonly value: unknown; readonly role: DataRole }
  | { readonly kind: "exit"; readonly value: object; readonly role: DataRole };

type DataRole = "schema" | "map" | "schemas" | "slots" | "data";
const ROLE_BITS: Readonly<Record<DataRole, number>> = {
  schema: 1,
  map: 2,
  schemas: 4,
  slots: 8,
  data: 16,
};

interface GuardRuntime {
  readonly pending: GuardFrame[];
  readonly active: WeakMap<object, number>;
  readonly completed: WeakMap<object, number>;
  cyclic: boolean;
}

// Descriptor safety is separate from schema semantics and cycle diagnostics.
// Each identity is inspected per role: schema sharing cannot exempt literal data.
export function inspectValidationData(
  value: unknown,
  role: "schema" | "data" = "data",
): ValidationDataInspection {
  const runtime: GuardRuntime = {
    pending: [{ kind: "enter", value, role }],
    active: new WeakMap(),
    completed: new WeakMap(),
    cyclic: false,
  };
  try {
    while (runtime.pending.length > 0) {
      const frame = runtime.pending.pop();
      if (frame === undefined) continue;
      if (!inspectFrame(frame, runtime))
        return { safe: false, cyclic: runtime.cyclic };
    }
    return { safe: true, cyclic: runtime.cyclic };
  } catch {
    return { safe: false, cyclic: runtime.cyclic };
  }
}

function inspectFrame(frame: GuardFrame, runtime: GuardRuntime): boolean {
  const bit = ROLE_BITS[frame.role];
  if (frame.kind === "exit") {
    runtime.active.set(
      frame.value,
      (runtime.active.get(frame.value) ?? 0) & ~bit,
    );
    runtime.completed.set(
      frame.value,
      (runtime.completed.get(frame.value) ?? 0) | bit,
    );
    return true;
  }
  const target = frame.value;
  if (typeof target !== "object" || target === null)
    return isDataPrimitive(target);
  if (frame.role === "data" && !hasDataPrototype(target)) return false;
  const active = runtime.active.get(target) ?? 0;
  if (active !== 0) runtime.cyclic = true;
  if (
    (active & bit) !== 0 ||
    ((runtime.completed.get(target) ?? 0) & bit) !== 0
  )
    return true;
  runtime.active.set(target, active | bit);
  pushOwn(runtime.pending, { kind: "exit", value: target, role: frame.role });
  return queueDataDescriptors(target, frame.role, runtime.pending);
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

function queueDataDescriptors(
  value: object,
  role: DataRole,
  pending: GuardFrame[],
): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    if (Array.isArray(value) && !isArrayDataKey(key, value.length))
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      return false;
    const child: unknown = descriptor.value;
    pushOwn(pending, {
      kind: "enter",
      value: child,
      role: childRole(role, key, child),
    });
  }
  return true;
}

function childRole(role: DataRole, key: string, value: unknown): DataRole {
  if (role === "map") return "schema";
  if (role === "schemas") return key === "length" ? "data" : "schema";
  if (role !== "schema") return "data";
  if (key === "properties" || key === "patternProperties") return "map";
  if (key === "type" || key === "required") return "slots";
  if (key === "items") return Array.isArray(value) ? "schemas" : "schema";
  if (key === "not") return "schema";
  if (key === "anyOf" || key === "oneOf" || key === "allOf") return "schemas";
  return "data";
}

function isArrayDataKey(key: string, length: number): boolean {
  if (key === "length") return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}
