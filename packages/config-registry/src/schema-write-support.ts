import { validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { z } from "zod";
import {
  appendOwn,
  concatOwn,
  filterOwn,
  mapOwn,
  ownEntries,
  ownField,
  ownValue,
  ownValues,
  preflightWitness,
  schemaEntries,
  someOwn,
  tailOwn,
} from "./structural-witness-own-data";

type Schema = ConfigurationPropertySchema;

export interface StructuralSupport {
  readonly declared: boolean;
  readonly arrayIndex: boolean;
  readonly ambiguous: boolean;
}

export const structuralSupportSchema = z.object({
  declared: z.boolean(),
  arrayIndex: z.boolean(),
  ambiguous: z.boolean(),
}) satisfies z.ZodType<StructuralSupport>;

const unsupported: StructuralSupport = {
  declared: false,
  arrayIndex: false,
  ambiguous: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function allows(schema: Schema, type: "object" | "array"): boolean {
  const declaredType = ownField(schema, "type");
  return Array.isArray(declaredType)
    ? someOwn(declaredType, (member) => member === type)
    : declaredType === type;
}

function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return ownValue(value, Number(key));
  return isRecord(value) ? ownValue(value, key) : undefined;
}

export function validBranch(schema: Schema, candidate: unknown): boolean {
  return validateEffectiveConfiguration(schema, candidate).valid;
}

export function objectMembers(schema: Schema, key: string): Schema[] {
  const members: Schema[] = [];
  const properties = ownField(schema, "properties");
  if (properties && Object.hasOwn(properties, key)) {
    const declared = ownField(properties, key);
    if (declared) appendOwn(members, declared);
  }
  for (const [pattern, member] of schemaEntries(
    ownField(schema, "patternProperties") ?? {},
  )) {
    if (matchesPattern(pattern, key)) appendOwn(members, member);
  }
  if (members.length > 0) return members;
  const additional = ownField(schema, "additionalProperties");
  return additional !== null && typeof additional === "object"
    ? [additional]
    : [];
}

function matchesPattern(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern).test(key);
  } catch {
    return false;
  }
}

export function arrayMembers(schema: Schema, key: string): Schema[] {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return [];
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index > 4_294_967_294) return [];
  const items = ownField(schema, "items");
  if (!items) return [];
  const member = Array.isArray(items) ? ownField(items, index) : items;
  return member ? [member] : [];
}

function directSupport(
  schema: Schema,
  path: readonly string[],
  incoming: unknown,
  candidate: unknown,
  previous: unknown,
  ancestors: Set<Schema>,
): StructuralSupport {
  if (path.length === 0)
    return payloadSupport(schema, incoming, candidate, previous, ancestors);
  const key = ownField(path, 0);
  if (key === undefined) return unsupported;
  const object = allows(schema, "object");
  const array = allows(schema, "array");
  const numeric = /^(?:0|[1-9][0-9]*)$/.test(key);
  if (
    numeric &&
    array &&
    !isRecord(previous) &&
    !Array.isArray(previous) &&
    object
  )
    return { ...unsupported, ambiguous: true };
  const arrayIndex = Array.isArray(previous) || (array && !object);
  if (arrayIndex && numeric && path.length > 0) {
    const members = arrayMembers(schema, key);
    return traverseMembers(
      members,
      tailOwn(path),
      incoming,
      candidate,
      previous,
      key,
      ancestors,
      true,
    );
  }
  const members = object ? objectMembers(schema, key) : [];
  return traverseMembers(
    members,
    tailOwn(path),
    incoming,
    candidate,
    previous,
    key,
    ancestors,
    false,
  );
}

function traverseMembers(
  members: readonly Schema[],
  path: readonly string[],
  incoming: unknown,
  candidate: unknown,
  previous: unknown,
  key: string,
  ancestors: Set<Schema>,
  arrayIndex: boolean,
): StructuralSupport {
  let declared = false;
  let nestedArray = arrayIndex;
  let ambiguous = false;
  for (const member of ownValues(members)) {
    const result = walkSupport(
      member,
      path,
      incoming,
      child(candidate, key),
      child(previous, key),
      ancestors,
    );
    declared ||= result.declared;
    nestedArray ||= result.arrayIndex;
    ambiguous ||= result.ambiguous;
  }
  return { declared, arrayIndex: nestedArray, ambiguous };
}

function payloadSupport(
  schema: Schema,
  incoming: unknown,
  candidate: unknown,
  previous: unknown,
  ancestors: Set<Schema>,
): StructuralSupport {
  if (!isRecord(incoming) && !Array.isArray(incoming))
    return { ...unsupported, declared: true };
  for (const [key, value] of ownEntries(incoming)) {
    const result = directSupport(
      schema,
      [key],
      value,
      candidate,
      previous,
      ancestors,
    );
    if (!result.declared) return result;
  }
  return { ...unsupported, declared: true };
}

function walkSupport(
  schema: Schema,
  path: readonly string[],
  incoming: unknown,
  candidate: unknown,
  previous: unknown,
  ancestors: Set<Schema>,
): StructuralSupport {
  if (ancestors.has(schema)) return unsupported;
  ancestors.add(schema);
  const combine = (branch: Schema) =>
    walkSupport(branch, path, incoming, candidate, previous, ancestors);
  const direct = directSupport(
    schema,
    path,
    incoming,
    candidate,
    previous,
    ancestors,
  );
  const allOf = ownField(schema, "allOf");
  const all = allOf ? mapOwn(new Set(ownValues(allOf)), combine) : [];
  const valid = (branch: Schema) => validBranch(branch, candidate);
  const anyOf = ownField(schema, "anyOf");
  const any = anyOf && mapOwn(filterOwn(anyOf, valid), combine);
  const oneOf = ownField(schema, "oneOf");
  const one = oneOf && mapOwn(filterOwn(oneOf, valid), combine);
  ancestors.delete(schema);
  const witnesses = concatOwn([direct], all);
  const declared =
    (someOwn(witnesses, (part) => part.declared) ||
      (any ? someOwn(any, (part) => part.declared) : false) ||
      (one ? someOwn(one, (part) => part.declared) : false)) &&
    (!any || someOwn(any, (part) => part.declared)) &&
    (!one || (one.length === 1 && ownField(one, 0)?.declared === true));
  const parts = concatOwn(witnesses, any ?? [], one ?? []);
  return {
    declared,
    arrayIndex: someOwn(parts, (part) => part.arrayIndex),
    ambiguous: someOwn(parts, (part) => part.ambiguous),
  };
}

export function schemaWriteSupport(
  schema: Schema,
  path: readonly string[],
  incoming: unknown,
  fullCandidate: unknown,
  previous: unknown,
): StructuralSupport {
  preflightWitness(schema, path, incoming, fullCandidate, previous);
  return walkSupport(
    schema,
    path,
    incoming,
    fullCandidate,
    previous,
    new Set(),
  );
}
