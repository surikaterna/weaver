import { validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { z } from "zod";

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

function allows(schema: Schema, type: "object" | "array"): boolean {
  return Array.isArray(schema.type)
    ? schema.type.includes(type)
    : schema.type === type;
}

function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value[Number(key)];
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function validBranch(schema: Schema, candidate: unknown): boolean {
  return validateEffectiveConfiguration(schema, candidate).valid;
}

function objectMembers(schema: Schema, key: string): Schema[] {
  const members: Schema[] = [];
  if (schema.properties && Object.hasOwn(schema.properties, key)) {
    const declared = schema.properties[key];
    if (declared) members.push(declared);
  }
  for (const [pattern, member] of Object.entries(
    schema.patternProperties ?? {},
  )) {
    if (matchesPattern(pattern, key)) members.push(member);
  }
  if (members.length > 0) return members;
  const additional = schema.additionalProperties;
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

function arrayMembers(schema: Schema, key: string): Schema[] {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return [];
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index > 4_294_967_294) return [];
  const items = schema.items;
  if (!items) return [];
  const member = Array.isArray(items) ? items[index] : items;
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
  const key = path[0];
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
  ) {
    return { ...unsupported, ambiguous: true };
  }
  const arrayIndex = Array.isArray(previous) || (array && !object);
  if (arrayIndex && numeric && path.length > 0) {
    const members = arrayMembers(schema, key);
    return traverseMembers(
      members,
      path.slice(1),
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
    path.slice(1),
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
  for (const member of members) {
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
  for (const [key, value] of Object.entries(incoming)) {
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
  const all = schema.allOf ? [...new Set(schema.allOf)].map(combine) : [];
  const any = schema.anyOf
    ?.filter((branch) => validBranch(branch, candidate))
    .map(combine);
  const one = schema.oneOf
    ?.filter((branch) => validBranch(branch, candidate))
    .map(combine);
  ancestors.delete(schema);
  const witnesses = [direct, ...all];
  const declared =
    (witnesses.some((part) => part.declared) ||
      (any?.some((part) => part.declared) ?? false) ||
      (one?.some((part) => part.declared) ?? false)) &&
    (!any || any.some((part) => part.declared)) &&
    (!one || (one.length === 1 && one[0]?.declared === true));
  const parts = [...witnesses, ...(any ?? []), ...(one ?? [])];
  return {
    declared,
    arrayIndex: parts.some((part) => part.arrayIndex),
    ambiguous: parts.some((part) => part.ambiguous),
  };
}

export function schemaWriteSupport(
  schema: Schema,
  path: readonly string[],
  incoming: unknown,
  fullCandidate: unknown,
  previous: unknown,
): StructuralSupport {
  return walkSupport(
    schema,
    path,
    incoming,
    fullCandidate,
    previous,
    new Set(),
  );
}
