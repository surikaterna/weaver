import { createWeaverError } from "@weaver-conf/config-types";
import { isPlainObject } from "./merge-traversal";

interface CopyTask {
  readonly value: unknown;
  readonly assign: (value: unknown) => void;
}

interface CopyContext {
  readonly active: WeakSet<object>;
  readonly tasks: (() => void)[];
}

function invalid(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}

function dataDescriptors(value: object): [string, PropertyDescriptor][] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length)
    invalid("Symbols are not snapshot data");
  const entries = Object.entries(descriptors);
  for (const [key, descriptor] of entries) {
    if (!("value" in descriptor)) invalid("Accessors are not snapshot data");
    if (["__proto__", "constructor", "prototype"].includes(key))
      invalid("Unsafe snapshot key");
  }
  return entries;
}

// Explicit enter/exit tasks accept acyclic sharing without retaining input aliases.
function visit({ value, assign }: CopyTask, context: CopyContext): void {
  const { active, tasks } = context;
  if (typeof value === "function") {
    throw createWeaverError(
      "UNSUPPORTED_OPERATION",
      "Executable snapshot data is unsupported",
    );
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "symbol" || typeof value === "bigint")
      invalid("Unsupported snapshot value");
    assign(value);
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value))
    invalid("Snapshot requires plain data");
  if (active.has(value)) invalid("Cyclic snapshot data");
  const descriptors = dataDescriptors(value);
  const target: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  active.add(value);
  assign(target);
  tasks.push(() => {
    active.delete(value);
    Object.freeze(target);
  });
  for (const [key, descriptor] of descriptors.reverse()) {
    const child: unknown = descriptor.value;
    if (Array.isArray(value) && key === "length") {
      Object.defineProperty(target, "length", { value: child });
      continue;
    }
    schedule(context, {
      value: child,
      assign: (copied) => {
        Object.defineProperty(target, key, {
          value: copied,
          enumerable: descriptor.enumerable === true,
        });
      },
    });
  }
}

function schedule(context: CopyContext, task: CopyTask): void {
  context.tasks.push(() => visit(task, context));
}

export function copySnapshotData(input: unknown): unknown {
  let result: unknown;
  const context: CopyContext = { active: new WeakSet(), tasks: [] };
  schedule(context, {
    value: input,
    assign: (value) => {
      result = value;
    },
  });
  while (context.tasks.length) context.tasks.pop()?.();
  return result;
}

export function freezeSnapshotData<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current !== "object" ||
      Object.isFrozen(current)
    )
      continue;
    pending.push(...Object.values(current));
    Object.freeze(current);
  }
  return value;
}
