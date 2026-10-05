import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import {
  allows,
  arrayMembers,
  objectMembers,
  validBranch,
} from "./schema-write-support";
import { ownField } from "./structural-witness-own-data";

type Schema = ConfigurationPropertySchema;
export interface ReadEvidence {
  readonly schemas: readonly Schema[];
  readonly forbidden: boolean;
  readonly ambiguous: boolean;
}

function restricted(schema: Schema): boolean {
  const policy = ownField(schema, "x-weaver");
  if (!policy) return false;
  const visibility = ownField(policy, "visibility");
  return (
    ownField(policy, "sensitive") === true ||
    (visibility !== undefined && visibility !== "public")
  );
}

// The member selection is the corrected shared write witness. This walk adds read
// policy evidence, not a new validator, and never calls its recursive payload walk.
export function expandReadEvidence(
  schemas: readonly Schema[],
  candidate: unknown,
): ReadEvidence {
  const pending = [...schemas];
  const seen = new Set<Schema>();
  const expanded: Schema[] = [];
  let forbidden = false;
  let ambiguous = false;
  while (pending.length) {
    const schema = pending.pop();
    if (!schema || seen.has(schema)) continue;
    seen.add(schema);
    expanded.push(schema);
    forbidden ||= restricted(schema);
    const alternatives = expandBranches(schema, candidate, pending);
    ambiguous ||= alternatives;
  }
  return Object.freeze({
    schemas: Object.freeze(expanded),
    forbidden,
    ambiguous,
  });
}

function expandBranches(
  schema: Schema,
  candidate: unknown,
  pending: Schema[],
): boolean {
  for (const branch of ownField(schema, "allOf") ?? []) pending.push(branch);
  let uncertain = false;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = ownField(schema, keyword);
    if (!branches) continue;
    const eligible = eligibleBranches(branches, candidate);
    if (
      candidate !== undefined &&
      (eligible.length === 0 || (keyword === "oneOf" && eligible.length !== 1))
    )
      uncertain = true;
    for (const branch of eligible.length ? eligible : branches)
      pending.push(branch);
  }
  const negative = ownField(schema, "not");
  if (negative && candidate !== undefined && !validBranch(schema, candidate))
    uncertain = true;
  return uncertain;
}

function eligibleBranches(
  branches: readonly Schema[],
  candidate: unknown,
): Schema[] {
  return candidate === undefined
    ? []
    : branches.filter((branch) => validBranch(branch, candidate));
}

export function readMemberSchemas(
  evidence: ReadEvidence,
  key: string,
  candidate: unknown,
): Schema[] {
  const members: Schema[] = [];
  const seen = new Set<Schema>();
  for (const schema of evidence.schemas) {
    const array = allows(schema, "array");
    const object = allows(schema, "object");
    const selected =
      Array.isArray(candidate) || (array && !object)
        ? arrayMembers(schema, key)
        : object
          ? objectMembers(schema, key)
          : [];
    for (const member of selected) {
      if (seen.has(member)) continue;
      seen.add(member);
      members.push(member);
    }
  }
  return members;
}

export function readMemberIsAmbiguous(
  evidence: ReadEvidence,
  key: string,
  candidate: unknown,
): boolean {
  if (
    !/^(0|[1-9][0-9]*)$/.test(key) ||
    (candidate !== null && typeof candidate === "object")
  )
    return false;
  for (const schema of evidence.schemas) {
    if (allows(schema, "array") && allows(schema, "object")) return true;
  }
  return false;
}
