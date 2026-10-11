import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import {
  expandReadEvidence,
  type ReadEvidence,
  readMemberEvidence,
} from "./registered-read-metadata";
import { allows, arrayMembers, objectMembers } from "./schema-member-evidence";
import { ownField, ownValue } from "./structural-witness-own-data";

interface PathCeiling {
  readonly path: readonly string[];
  readonly layer: string;
}
interface Frame {
  readonly path: readonly string[];
  readonly schemas: readonly ConfigurationPropertySchema[];
  readonly candidate: unknown;
  readonly unconstrained: boolean;
}

/** Canonical branch/member witnesses over raw candidates, never projected data. */
export function ceilingPaths(
  schema: ConfigurationPropertySchema,
  candidates: readonly unknown[],
): readonly PathCeiling[] {
  const output: PathCeiling[] = [];
  const pending: Frame[] = candidates.map((candidate) => ({
    path: [],
    schemas: [schema],
    candidate,
    unconstrained: false,
  }));
  while (pending.length) {
    const frame = pending.pop();
    if (!frame) continue;
    const evidence = expandReadEvidence(
      frame.schemas,
      frame.candidate,
      frame.unconstrained,
    );
    for (const schema of evidence.schemas) {
      const layer = ownField(schema, "x-weaver")?.maxOverrideLayer;
      if (layer !== undefined) output.push({ path: frame.path, layer });
    }
    for (const key of memberKeys(
      evidence.schemas,
      candidates.map((value) => at(value, frame.path)),
    )) {
      const member = readMemberEvidence(evidence, key, frame.candidate);
      const declared = declarationEvidence(evidence, key);
      const schemas = [...new Set([...member.schemas, ...declared])];
      // An inherited ceiling already covers permissive and undeclared descendants.
      if (!schemas.length) continue;
      pending.push({
        path: [...frame.path, key],
        schemas,
        candidate: child(frame.candidate, key),
        unconstrained: member.unconstrained,
      });
    }
  }
  return output;
}

function declarationEvidence(evidence: ReadEvidence, key: string) {
  // Finite declarations protect ancestors even when no raw value has that kind.
  return evidence.schemas.flatMap((schema) => [
    ...(allows(schema, "object") ? objectMembers(schema, key).schemas : []),
    ...(allows(schema, "array") && Array.isArray(ownField(schema, "items"))
      ? arrayMembers(schema, key).schemas
      : []),
  ]);
}

function memberKeys(
  schemas: readonly ConfigurationPropertySchema[],
  values: readonly unknown[],
): Set<string> {
  const keys = new Set(
    values.flatMap((value) =>
      value !== null && typeof value === "object" ? Object.keys(value) : [],
    ),
  );
  for (const schema of schemas) {
    // Missing declarations still protect against destructive ancestor replacement.
    if (allows(schema, "object")) {
      for (const key of Object.keys(ownField(schema, "properties") ?? {}))
        keys.add(key);
    }
    const items = ownField(schema, "items");
    if (allows(schema, "array") && Array.isArray(items)) {
      for (const index of items.keys()) keys.add(String(index));
    }
  }
  return keys;
}
function child(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? ownValue(value, key)
    : undefined;
}
function at(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = child(value, key);
  return value;
}
