import {
  deepGet,
  deepSet,
  materializeConfigurationDefaultsForSchemas,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
} from "@weaver-conf/config-engine";
import {
  containsRegistrationDefaultMarker,
  type SchemaValidationError,
} from "@weaver-conf/config-types";
import type { RegisteredSchemaAnchor } from "./schema-registry";

type EffectiveCandidate =
  | { readonly valid: true; readonly entries: Record<string, unknown> }
  | {
      readonly valid: false;
      readonly entries: Record<string, unknown>;
      readonly anchorPath: string;
      readonly errors: readonly SchemaValidationError[];
    };

/** Materialize once across all governing roots, then validate that same candidate against each. */
export function evaluateEffectiveCandidate(
  anchors: readonly RegisteredSchemaAnchor[],
  entries: Record<string, unknown>,
): EffectiveCandidate {
  const candidate = evaluateRawEffectiveCandidate(anchors, entries);
  if (containsRegistrationDefaultMarker(candidate.entries))
    return markerFailure(candidate.entries);
  return candidate;
}

/** Raw write preflight shares default/validation authority but may still contain legitimate unresolved references. */
export function evaluateRawEffectiveCandidate(
  anchors: readonly RegisteredSchemaAnchor[],
  entries: Record<string, unknown>,
): EffectiveCandidate {
  const ordered = [...anchors].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const candidate = structuredClone(entries);
  const groups = new Map<string, RegisteredSchemaAnchor[]>();
  for (const anchor of ordered)
    groups.set(anchor.path, [...(groups.get(anchor.path) ?? []), anchor]);
  for (const [path, members] of groups)
    materializeRoot(path, members, candidate);
  for (const anchor of ordered) {
    const path = parseCanonicalConfigPath(anchor.path);
    const root = path.segments[0];
    if (root !== undefined && !Object.hasOwn(candidate, root)) continue;
    const result = validateEffectiveConfiguration(
      anchor.schema,
      deepGet(candidate, path.storageKey),
      { path: path.segments },
    );
    if (!result.valid)
      return {
        valid: false,
        entries: candidate,
        anchorPath: anchor.path,
        errors: result.errors,
      };
  }
  return { valid: true, entries: candidate };
}

function markerFailure(entries: Record<string, unknown>): EffectiveCandidate {
  return {
    valid: false,
    entries,
    anchorPath: "/",
    errors: [
      {
        code: "invalid-value",
        path: "$",
        segments: [],
        message:
          "Effective configuration must not contain mount or secret-ref markers",
      },
    ],
  };
}

function materializeRoot(
  path: string,
  anchors: readonly RegisteredSchemaAnchor[],
  entries: Record<string, unknown>,
): void {
  const parsed = parseCanonicalConfigPath(path);
  const rootKey = parsed.segments[0];
  const value = materializeConfigurationDefaultsForSchemas(
    anchors.map((anchor) => anchor.schema),
    deepGet(entries, parsed.storageKey),
    rootKey !== undefined && !Object.hasOwn(entries, rootKey),
  );
  if (value !== undefined) deepSet(entries, parsed.storageKey, value);
}
