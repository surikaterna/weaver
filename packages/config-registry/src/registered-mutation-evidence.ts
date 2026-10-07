import { projectConfigurationData } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import {
  configurationPropertySchemaSchema,
  createWeaverError,
  isReservedPathSegment,
} from "@weaver-conf/config-types";
import type {
  RegisteredMutationEvidence,
  RegisteredMutationFootprint,
} from "./registered-mutation-contracts";
import { isReadReference } from "./registered-read-contexts";
import {
  expandReadEvidence,
  type ReadEvidence,
  readMemberEvidence,
  readMemberIsAmbiguous,
} from "./registered-read-metadata";
import { allows } from "./schema-member-evidence";
import {
  ownField,
  ownValue,
  preflightWitness,
} from "./structural-witness-own-data";

type Schema = ConfigurationPropertySchema;

/** Traverses canonical branch/member evidence; never validates a new schema model. */
export function registeredMutationEvidence(
  schema: Schema,
  path: readonly string[],
  candidate: unknown,
): RegisteredMutationEvidence {
  preflightWitness(schema, path, undefined, candidate, undefined);
  return pathEvidence(schema, path, candidate);
}

function pathEvidence(
  schema: Schema,
  path: readonly string[],
  candidate: unknown,
): RegisteredMutationEvidence {
  let evidence = expandReadEvidence([schema], candidate);
  const ancestors = new Set<Schema>();
  let ambiguous = evidence.ambiguous;
  let reference = isReadReference(candidate);
  let reserved = false;
  for (const key of path) {
    for (const item of evidence.schemas) ancestors.add(item);
    ambiguous ||= readMemberIsAmbiguous(evidence, key, candidate);
    reserved ||= isReservedPathSegment(key);
    const member = readMemberEvidence(evidence, key, candidate);
    candidate = child(candidate, key);
    reference ||= isReadReference(candidate);
    evidence = expandReadEvidence(
      member.schemas,
      candidate,
      member.unconstrained,
    );
    ambiguous ||= evidence.ambiguous;
  }
  const policy = classify([...ancestors, ...evidence.schemas]);
  return Object.freeze({
    schemas: evidence.schemas,
    ancestors: Object.freeze([...ancestors]),
    declared: evidence.unconstrained || evidence.schemas.length > 0,
    unconstrained: evidence.unconstrained,
    ambiguous,
    sensitive: policy.sensitive,
    forbidden: reserved || policy.forbidden,
    reference,
    containers: Object.freeze(containerKinds(evidence)),
  });
}

function child(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? ownValue(value, key)
    : undefined;
}

function classify(schemas: readonly Schema[]) {
  let sensitive = false;
  let forbidden = false;
  for (const schema of schemas) {
    const policy = ownField(schema, "x-weaver");
    if (!policy) continue;
    sensitive ||= ownField(policy, "sensitive") === true;
    const visibility = ownField(policy, "visibility");
    forbidden ||= visibility === "internal";
  }
  return { sensitive, forbidden };
}

function containerKinds(evidence: ReadEvidence): ("object" | "array")[] {
  if (!evidence.unconstrained && evidence.schemas.length === 0) return [];
  const kinds: ("object" | "array")[] = ["object", "array"];
  return kinds.filter((kind) =>
    evidence.schemas.every(
      (schema) =>
        ownField(schema, "type") === undefined || allows(schema, kind),
    ),
  );
}

/** Includes removed/masked declarations, but not siblings carried by an anchor patch. */
export function registeredMutationFootprint(
  schema: Schema,
  path: readonly string[],
  before: unknown,
  after: unknown,
): RegisteredMutationFootprint {
  preflightWitness(schema, path, undefined, after, before);
  if (
    !configurationPropertySchemaSchema.safeParse(schema).success ||
    !validSnapshotData([before, after])
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid mutation evidence data",
    );
  const pending = [[...path]];
  const output: RegisteredMutationFootprint[number][] = [];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    const old = pathEvidence(schema, current, before);
    const next = pathEvidence(schema, current, after);
    output.push(
      Object.freeze({ path: Object.freeze(current), before: old, after: next }),
    );
    const keys = footprintKeys(
      old,
      next,
      at(before, current),
      at(after, current),
    );
    for (const key of keys) pending.push([...current, key]);
  }
  return Object.freeze(output);
}

function validSnapshotData(value: unknown): boolean {
  try {
    // Existing raw layers may carry inert reserved keys; the footprint classifies
    // those paths as forbidden rather than rejecting an unrelated safe sibling.
    projectConfigurationData(
      value,
      {},
      {
        decide: () => "retain",
        child: (context) => context,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function at(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = child(value, key);
  return value;
}

function footprintKeys(
  before: RegisteredMutationEvidence,
  after: RegisteredMutationEvidence,
  old: unknown,
  next: unknown,
): Set<string> {
  const keys = new Set<string>();
  for (const value of [old, next]) {
    if (value !== null && typeof value === "object")
      for (const key of Object.keys(value)) keys.add(key);
  }
  addObjectDeclarations(keys, before, old);
  addObjectDeclarations(keys, after, next);
  return keys;
}

function addObjectDeclarations(
  keys: Set<string>,
  evidence: RegisteredMutationEvidence,
  value: unknown,
): void {
  // Object-only declarations are not phantom members of an atomic array/null.
  if (
    value !== undefined &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  )
    return;
  for (const schema of evidence.schemas) {
    if (!allows(schema, "object")) continue;
    for (const key of Object.keys(ownField(schema, "properties") ?? {}))
      keys.add(key);
  }
}
