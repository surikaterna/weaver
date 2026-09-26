import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

type GraphFrame =
  | { readonly kind: "enter"; readonly value: object }
  | { readonly kind: "exit"; readonly value: object };

export function collectConstraintRoots(
  schema: ConfigurationPropertySchema,
  roots: unknown[],
): void {
  if (Object.hasOwn(schema, "default") && isObjectValue(schema.default))
    roots.push(schema.default);
  if (Object.hasOwn(schema, "const") && isObjectValue(schema.const))
    roots.push(schema.const);
  if (Object.hasOwn(schema, "enum") && isObjectValue(schema.enum))
    roots.push(schema.enum);
}

export function hasObjectCycle(roots: readonly unknown[]): boolean {
  let pending: GraphFrame[] | undefined;
  for (let index = roots.length - 1; index >= 0; index--) {
    const root = roots[index];
    if (isObjectValue(root)) {
      pending ??= [];
      pending.push({ kind: "enter", value: root });
    }
  }
  if (pending === undefined) return false;
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    if (active.has(frame.value)) return true;
    if (completed.has(frame.value)) continue;
    active.add(frame.value);
    pending.push({ kind: "exit", value: frame.value });
    pushObjectChildren(frame.value, pending);
  }
  return false;
}

function pushObjectChildren(value: object, pending: GraphFrame[]): void {
  const children = Object.values(value);
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (isObjectValue(child)) pending.push({ kind: "enter", value: child });
  }
}

function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
