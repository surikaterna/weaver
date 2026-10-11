import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { z } from "zod";
import {
  allows,
  arrayMembers,
  type MemberEvidence,
  objectMembers,
  validBranch,
} from "./schema-member-evidence";
import {
  denseMetadata,
  ownField,
  ownValue,
  preflightWitness,
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

function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return ownValue(value, Number(key));
  return isRecord(value) ? ownValue(value, key) : undefined;
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
    return payloadSupport(schema, incoming, candidate, ancestors);
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
  )
    return { ...unsupported, ambiguous: true };
  const arrayIndex = Array.isArray(previous) || (array && !object);
  const indexed = arrayIndex && numeric;
  const members = indexed
    ? arrayMembers(schema, key)
    : object
      ? objectMembers(schema, key)
      : { schemas: [], unconstrained: false };
  return traverseMembers(
    members,
    path.slice(1),
    incoming,
    candidate,
    previous,
    key,
    ancestors,
    // Array ancestry constrains generic traversal even for a nonnumeric member
    // whose prospective candidate would otherwise look like an object.
    arrayIndex,
  );
}

function traverseMembers(
  members: MemberEvidence,
  path: readonly string[],
  incoming: unknown,
  candidate: unknown,
  previous: unknown,
  key: string,
  ancestors: Set<Schema>,
  arrayIndex: boolean,
): StructuralSupport {
  const open = members.unconstrained
    ? unconstrainedSupport(path, child(candidate, key), child(previous, key))
    : unsupported;
  let declared = open.declared;
  let nestedArray = arrayIndex || open.arrayIndex;
  let ambiguous = open.ambiguous;
  for (const member of members.schemas) {
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

function unconstrainedSupport(
  path: readonly string[],
  candidate: unknown,
  previous: unknown,
): StructuralSupport {
  let arrayIndex = false;
  let ambiguous = false;
  for (const key of path) {
    const numeric = /^(?:0|[1-9][0-9]*)$/.test(key);
    arrayIndex ||= Array.isArray(previous) || Array.isArray(candidate);
    ambiguous ||=
      numeric &&
      !isRecord(previous) &&
      !Array.isArray(previous) &&
      !isRecord(candidate) &&
      !Array.isArray(candidate);
    candidate = child(candidate, key);
    previous = child(previous, key);
  }
  return { declared: true, arrayIndex, ambiguous };
}

function payloadSupport(
  schema: Schema,
  incoming: unknown,
  candidate: unknown,
  ancestors: Set<Schema>,
): StructuralSupport {
  if (!isRecord(incoming) && !Array.isArray(incoming))
    return { ...unsupported, declared: true };
  const container = Array.isArray(incoming) ? "array" : "object";
  // At a declared value boundary, kind mismatches belong to engine validation.
  if (!allows(schema, container)) return { ...unsupported, declared: true };
  // Payload members use the new container. Old-container ancestry remains in
  // the outer logical-path walk and in the independent before/after policy proof.
  // Records can inherit discriminator data; arrays replace their contents atomically.
  const context =
    isRecord(incoming) && isRecord(candidate) ? candidate : incoming;
  for (const [key, value] of Object.entries(incoming)) {
    const result = directSupport(
      schema,
      [key],
      value,
      context,
      incoming,
      ancestors,
    );
    if (!result.declared) return { ...result, arrayIndex: false };
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
  // An array replaces the value at this boundary; unrelated effective overlays
  // cannot select its branches. Ancestor paths and partial records keep context.
  const context =
    path.length === 0 && Array.isArray(incoming) ? incoming : candidate;
  const combine = (branch: Schema) =>
    walkSupport(branch, path, incoming, context, previous, ancestors);
  const direct = directSupport(
    schema,
    path,
    incoming,
    context,
    previous,
    ancestors,
  );
  const allOf = compositionBranches(schema, "allOf");
  const all = allOf ? [...new Set(allOf)].map(combine) : [];
  const valid = (branch: Schema) => validBranch(branch, context);
  const any = compositionBranches(schema, "anyOf")?.filter(valid).map(combine);
  const one = compositionBranches(schema, "oneOf")?.filter(valid).map(combine);
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

function compositionBranches(
  schema: Schema,
  key: "allOf" | "anyOf" | "oneOf",
): readonly Schema[] | undefined {
  const branches = ownField(schema, key);
  if (branches !== undefined) denseMetadata(branches);
  return branches;
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
