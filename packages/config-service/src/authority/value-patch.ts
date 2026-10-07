import { registeredMutationEvidence } from "@weaver-conf/config-registry";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { z } from "zod";

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

export const schemaPatchResultSchema = z.discriminatedUnion("success", [
  z.strictObject({ success: z.literal(true), value: z.unknown() }),
  z.discriminatedUnion("reason", [
    z.strictObject({
      success: z.literal(false),
      reason: z.literal("invalid-array-index"),
      segment: z.string(),
    }),
    z.strictObject({
      success: z.literal(false),
      reason: z.literal("array-index-out-of-range"),
      index: z.number().int().nonnegative(),
      length: z.number().int().nonnegative(),
    }),
    z.strictObject({
      success: z.literal(false),
      reason: z.literal("invalid-container"),
      segment: z.string(),
    }),
  ]),
]) satisfies z.ZodType<SchemaPatchResult>;

export function buildSchemaPatch(
  baseValue: unknown,
  segments: readonly string[],
  value: unknown,
  schema: ConfigurationPropertySchema | undefined,
): SchemaPatchResult {
  const root = baseValue === undefined ? {} : clonePatchValue(baseValue);
  let current: unknown = root;
  for (let position = 0; position < segments.length; position++) {
    const segment = segments[position];
    if (segment === undefined) continue;
    const final = position === segments.length - 1;
    const create = () =>
      createContainer(schema, segments.slice(0, position + 1), root);
    const result = Array.isArray(current)
      ? patchArray(current, segment, create, value, final)
      : patchObject(current, segment, create, value, final);
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
  const pending = new Set<CloneFrame>([{ source: value, target: root }]);
  while (pending.size > 0) {
    const entry = pending.values().next();
    if (entry.done) continue;
    const frame = entry.value;
    pending.delete(frame);
    for (const [key, member] of Object.entries(frame.source)) {
      const cloned = cloneMember(member, clones, pending);
      defineOwnDataProperty(frame.target, key, cloned);
    }
  }
  return root;
}

function cloneMember(
  value: unknown,
  clones: WeakMap<object, CloneContainer>,
  pending: Set<CloneFrame>,
): unknown {
  if (!isObject(value)) return value;
  const existing = clones.get(value);
  if (existing !== undefined) return existing;
  const clone = emptyClone(value);
  clones.set(value, clone);
  pending.add({ source: value, target: clone });
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
  create: () => unknown,
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
  if (final) return defineOwnArrayIndex(current, index, segment, value);
  const existing = Object.hasOwn(current, String(index))
    ? current[index]
    : undefined;
  const next =
    isRecord(existing) || Array.isArray(existing) ? existing : create();
  if (next === undefined)
    return { success: false, reason: "invalid-container", segment };
  return defineOwnArrayIndex(current, index, segment, next);
}

function defineOwnArrayIndex(
  current: unknown[],
  index: number,
  segment: string,
  value: unknown,
): StepResult {
  try {
    const defined = Reflect.defineProperty(current, String(index), {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return defined
      ? { success: true, next: value }
      : { success: false, reason: "invalid-container", segment };
  } catch {
    return { success: false, reason: "invalid-container", segment };
  }
}

function patchObject(
  current: unknown,
  segment: string,
  create: () => unknown,
  value: unknown,
  final: boolean,
): StepResult {
  if (!isRecord(current)) {
    return { success: false, reason: "invalid-container", segment };
  }
  if (final) {
    defineOwnDataProperty(current, segment, value);
    return { success: true, next: value };
  }
  const existing = Object.hasOwn(current, segment)
    ? current[segment]
    : undefined;
  const next =
    isRecord(existing) || Array.isArray(existing) ? existing : create();
  if (next === undefined)
    return { success: false, reason: "invalid-container", segment };
  defineOwnDataProperty(current, segment, next);
  return { success: true, next };
}

function createContainer(
  schema: ConfigurationPropertySchema | undefined,
  path: readonly string[],
  candidate: unknown,
): unknown[] | Record<string, unknown> | undefined {
  if (!schema) return undefined;
  const evidence = registeredMutationEvidence(schema, path, candidate);
  if (evidence.containers.length !== 1) return undefined;
  return evidence.containers[0] === "array" ? [] : {};
}

function defineOwnDataProperty(
  target: CloneContainer,
  key: string,
  value: unknown,
): void {
  Reflect.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
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
