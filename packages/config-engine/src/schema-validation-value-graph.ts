import {
  addContextError,
  appendValidationPath,
  type SchemaValidationPathSegment,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

type ValueCycleFrame =
  | {
      readonly kind: "enter";
      readonly value: unknown;
      readonly path: ValidationPath;
    }
  | { readonly kind: "exit"; readonly value: object };

export function validateValueGraph(
  value: unknown,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  const cyclePath = findValueCycle(value, path);
  if (cyclePath === undefined) return true;
  addContextError(context, "invalid-value", cyclePath, {
    message: "Configuration values must not contain cycles",
  });
  return false;
}

function findValueCycle(
  value: unknown,
  path: ValidationPath,
): ValidationPath | undefined {
  if (!isObjectValue(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.some((entry) => isObjectValue(entry[1]))) return undefined;
  const active = new WeakSet<object>([value]);
  const completed = new WeakSet<object>();
  const pending: ValueCycleFrame[] = [{ kind: "exit", value }];
  pushValueEntries(value, path, entries, pending);
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    if (!isObjectValue(frame.value)) continue;
    if (active.has(frame.value)) return frame.path;
    if (completed.has(frame.value)) continue;
    active.add(frame.value);
    pending.push({ kind: "exit", value: frame.value });
    pushValueChildren(frame.value, frame.path, pending);
  }
  return undefined;
}

function pushValueChildren(
  value: object,
  path: ValidationPath,
  pending: ValueCycleFrame[],
): void {
  pushValueEntries(value, path, Object.entries(value), pending);
}

function pushValueEntries(
  value: object,
  path: ValidationPath,
  entries: [string, unknown][],
  pending: ValueCycleFrame[],
): void {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined) continue;
    pending.push({
      kind: "enter",
      value: entry[1],
      path: appendValidationPath(path, valuePathSegment(value, entry[0])),
    });
  }
}

function valuePathSegment(
  parent: object,
  key: string,
): SchemaValidationPathSegment {
  if (!Array.isArray(parent) || !/^(?:0|[1-9][0-9]*)$/.test(key)) return key;
  const index = Number(key);
  return Number.isSafeInteger(index) && index <= 4_294_967_294 ? index : key;
}

function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
