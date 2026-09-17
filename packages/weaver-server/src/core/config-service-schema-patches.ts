const MAX_ARRAY_INDEX = 4_294_967_294;

export type SchemaPatchResult =
  | { readonly success: true; readonly value: unknown }
  | {
      readonly success: false;
      readonly reason: "invalid-array-index";
      readonly segment: string;
    }
  | {
      readonly success: false;
      readonly reason: "array-index-out-of-range";
      readonly index: number;
      readonly length: number;
    }
  | {
      readonly success: false;
      readonly reason: "invalid-container";
      readonly segment: string;
    };

export function buildSchemaPatch(
  baseValue: unknown,
  segments: readonly string[],
  value: unknown,
): SchemaPatchResult {
  const root = baseValue === undefined ? {} : clonePatchValue(baseValue);
  let current: unknown = root;
  for (let position = 0; position < segments.length; position++) {
    const segment = segments[position];
    if (segment === undefined) continue;
    const final = position === segments.length - 1;
    const nextSegment = segments[position + 1];
    const result = Array.isArray(current)
      ? patchArray(current, segment, nextSegment, value, final)
      : patchObject(current, segment, nextSegment, value, final);
    if (!result.success) return result;
    current = result.next;
  }
  return { success: true, value: root };
}

type CloneContainer = Record<string, unknown> | unknown[];

interface CloneFrame {
  readonly source: object;
  readonly target: CloneContainer;
}

function clonePatchValue(value: unknown): unknown {
  if (!isObject(value)) return value;
  const root = emptyClone(value);
  const clones = new WeakMap<object, CloneContainer>([[value, root]]);
  const pending: CloneFrame[] = [{ source: value, target: root }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    for (const [key, member] of Object.entries(frame.source)) {
      const cloned = cloneMember(member, clones, pending);
      Reflect.set(frame.target, key, cloned);
    }
  }
  return root;
}

function cloneMember(
  value: unknown,
  clones: WeakMap<object, CloneContainer>,
  pending: CloneFrame[],
): unknown {
  if (!isObject(value)) return value;
  const existing = clones.get(value);
  if (existing !== undefined) return existing;
  const clone = emptyClone(value);
  clones.set(value, clone);
  pending.push({ source: value, target: clone });
  return clone;
}

function emptyClone(value: object): CloneContainer {
  return Array.isArray(value) ? new Array<unknown>(value.length) : {};
}

type StepResult =
  | { readonly success: true; readonly next: unknown }
  | Exclude<SchemaPatchResult, { readonly success: true }>;

function patchArray(
  current: unknown[],
  segment: string,
  nextSegment: string | undefined,
  value: unknown,
  final: boolean,
): StepResult {
  const index = parseArrayIndex(segment);
  if (index === undefined) {
    return { success: false, reason: "invalid-array-index", segment };
  }
  if (index > current.length) {
    return {
      success: false,
      reason: "array-index-out-of-range",
      index,
      length: current.length,
    };
  }
  if (final) {
    if (index === current.length) current.push(value);
    else current[index] = value;
    return { success: true, next: value };
  }
  const next = current[index] ?? createContainer(nextSegment);
  if (index === current.length) current.push(next);
  else current[index] = next;
  return { success: true, next };
}

function patchObject(
  current: unknown,
  segment: string,
  nextSegment: string | undefined,
  value: unknown,
  final: boolean,
): StepResult {
  if (!isRecord(current)) {
    return { success: false, reason: "invalid-container", segment };
  }
  if (final) {
    current[segment] = value;
    return { success: true, next: value };
  }
  const existing = Object.hasOwn(current, segment)
    ? current[segment]
    : undefined;
  const next =
    isRecord(existing) || Array.isArray(existing)
      ? existing
      : createContainer(nextSegment);
  current[segment] = next;
  return { success: true, next };
}

function createContainer(
  nextSegment: string | undefined,
): unknown[] | Record<string, unknown> {
  return nextSegment !== undefined && parseArrayIndex(nextSegment) !== undefined
    ? []
    : {};
}

function parseArrayIndex(segment: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) && index <= MAX_ARRAY_INDEX
    ? index
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
