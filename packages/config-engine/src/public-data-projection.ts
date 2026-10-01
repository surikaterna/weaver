import { copySnapshotData } from "./descriptor-copy";
import { defineOwnData, ownDataValue, pushOwn } from "./own-data";
import type { ConfigurationProjectionVisitor } from "./projection-contracts";

interface Traversal<C extends object> {
  readonly visitor: ConfigurationProjectionVisitor<C>;
  readonly memo: WeakMap<object, WeakMap<C, object>>;
  readonly tasks: (() => void)[];
}

export function projectConfigurationData<C extends object>(
  value: unknown,
  context: C,
  visitor: ConfigurationProjectionVisitor<C>,
): unknown {
  const safe = copySnapshotData(value);
  let result: unknown;
  const traversal: Traversal<C> = { visitor, memo: new WeakMap(), tasks: [] };
  schedule(
    safe,
    context,
    (output) => {
      result = output;
    },
    traversal,
  );
  while (traversal.tasks.length) traversal.tasks.pop()?.();
  return result;
}

function schedule<C extends object>(
  value: unknown,
  context: C,
  assign: (output: unknown) => void,
  traversal: Traversal<C>,
): void {
  pushOwn(traversal.tasks, () => visit(value, context, assign, traversal));
}

function visit<C extends object>(
  value: unknown,
  context: C,
  assign: (output: unknown) => void,
  traversal: Traversal<C>,
): void {
  let contexts =
    value !== null && typeof value === "object"
      ? traversal.memo.get(value)
      : undefined;
  const existing = contexts?.get(context);
  if (existing) {
    assign(existing);
    return;
  }
  const action = traversal.visitor.decide(value, context);
  if (action === "omit") return;
  if (action === "retain" || value === null || typeof value !== "object") {
    assign(value);
    return;
  }
  if (!contexts) {
    contexts = new WeakMap();
    traversal.memo.set(value, contexts);
  }
  const output: object = Array.isArray(value) ? [] : {};
  contexts.set(context, output);
  assign(output);
  if (Array.isArray(value))
    Object.defineProperty(output, "length", {
      value: ownDataValue(value, "length"),
    });
  if (!traversal.visitor.mutableContainers)
    pushOwn(traversal.tasks, () => {
      Object.freeze(output);
    });
  scheduleChildren(value, output, context, traversal);
}

function scheduleChildren<C extends object>(
  value: object,
  output: object,
  context: C,
  traversal: Traversal<C>,
): void {
  for (const key of Object.keys(value).reverse()) {
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) continue;
    if (Array.isArray(value) && traversal.visitor.preserveUndefinedArraySlots)
      defineOwnData(output, key, undefined);
    schedule(
      ownDataValue(value, key),
      traversal.visitor.child(context, key),
      (child) => {
        defineOwnData(output, key, child);
      },
      traversal,
    );
  }
}
