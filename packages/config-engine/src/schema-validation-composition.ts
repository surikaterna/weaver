import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  addContextError,
  type ValidationContext,
  type ValidationErrorPath,
  type ValidationMode,
} from "./schema-validation-support";

export const COMPOSITION_KEYWORDS = ["anyOf", "oneOf", "allOf", "not"] as const;

export type CompositionKeyword = (typeof COMPOSITION_KEYWORDS)[number];

export interface CompositionEntry {
  readonly keyword: CompositionKeyword;
  readonly branches: readonly ConfigurationPropertySchema[];
}

interface ModeMatch {
  partial?: boolean;
  effective?: boolean;
}

export type CompositionMemo = Map<
  ConfigurationPropertySchema,
  Map<unknown, ModeMatch>
>;

export function createCompositionMemo(): CompositionMemo {
  return new Map();
}

const SUPPORTED_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

export function validateCompositionShape(
  schema: ConfigurationPropertySchema,
  path: ValidationErrorPath,
  context: ValidationContext,
): boolean {
  for (const keyword of COMPOSITION_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    const valid =
      keyword === "not"
        ? validateNotShape(value, path, context)
        : validateBranchArrayShape(keyword, value, path, context);
    if (!valid) return false;
  }
  return true;
}

export function getCompositionEntries(
  schema: ConfigurationPropertySchema,
): readonly CompositionEntry[] {
  const entries: CompositionEntry[] = [];
  for (const keyword of COMPOSITION_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (keyword === "not") {
      if (isSupportedSchema(value))
        entries.push({ keyword, branches: [value] });
    } else if (Array.isArray(value)) {
      entries.push({ keyword, branches: value });
    }
  }
  return entries;
}

export function addCompositionResult(
  entry: CompositionEntry,
  matched: number,
  path: ValidationErrorPath,
  context: ValidationContext,
): void {
  if (compositionPassed(entry, matched)) return;
  addContextError(context, "invalid-value", path, {
    message: compositionMessage(entry, matched),
  });
}

export function getMemoizedCompositionMatch(
  memo: CompositionMemo,
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: ValidationMode,
): boolean | undefined {
  return memo.get(schema)?.get(value)?.[mode];
}

export function memoizeCompositionMatch(
  memo: CompositionMemo,
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: ValidationMode,
  matches: boolean,
): void {
  let values = memo.get(schema);
  if (values === undefined) {
    values = new Map();
    memo.set(schema, values);
  }
  const modes = values.get(value) ?? {};
  modes[mode] = matches;
  values.set(value, modes);
}

export function isSupportedSchema(
  value: unknown,
): value is ConfigurationPropertySchema {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const type = ownDataValue(value, "type");
  if (typeof type === "string") return SUPPORTED_TYPES.has(type);
  if (!Array.isArray(type) || type.length === 0) return false;
  for (let index = 0; index < type.length; index++) {
    const member: unknown = type[index];
    if (
      !Object.hasOwn(type, index) ||
      typeof member !== "string" ||
      !SUPPORTED_TYPES.has(member)
    ) {
      return false;
    }
  }
  return true;
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function validateNotShape(
  value: unknown,
  path: ValidationErrorPath,
  context: ValidationContext,
): boolean {
  if (isSupportedSchema(value)) return true;
  addContextError(context, "invalid-schema", path, {
    message: "not must be a schema object with a supported non-empty type",
  });
  return false;
}

function validateBranchArrayShape(
  keyword: Exclude<CompositionKeyword, "not">,
  value: unknown,
  path: ValidationErrorPath,
  context: ValidationContext,
): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return invalidBranchArray(keyword, path, context);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !isSupportedSchema(value[index])) {
      addContextError(context, "invalid-schema", path, {
        message: `${keyword} branch ${String(index)} must be a schema object with a supported non-empty type`,
      });
      return false;
    }
  }
  return true;
}

function invalidBranchArray(
  keyword: Exclude<CompositionKeyword, "not">,
  path: ValidationErrorPath,
  context: ValidationContext,
): false {
  addContextError(context, "invalid-schema", path, {
    message: `${keyword} must be a non-empty dense array of schema objects`,
  });
  return false;
}

function compositionPassed(entry: CompositionEntry, matched: number): boolean {
  if (entry.keyword === "anyOf") return matched >= 1;
  if (entry.keyword === "oneOf") return matched === 1;
  if (entry.keyword === "allOf") return matched === entry.branches.length;
  return matched === 0;
}

function compositionMessage(entry: CompositionEntry, matched: number): string {
  if (entry.keyword === "anyOf") {
    return "Value must match at least one anyOf branch";
  }
  if (entry.keyword === "oneOf") {
    return `Value must match exactly one oneOf branch (matched ${String(matched)})`;
  }
  if (entry.keyword === "allOf") {
    return `Value must match every allOf branch (matched ${String(matched)} of ${String(entry.branches.length)})`;
  }
  return "Value must not match the not schema";
}
