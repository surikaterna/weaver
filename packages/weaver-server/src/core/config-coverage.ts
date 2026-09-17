import {
  deepGet,
  parseCanonicalConfigPath,
  validateLayerConfiguration,
} from "@weaver-conf/config-engine";
import { createWeaverError } from "@weaver-conf/config-types";
import { evaluateEffectiveCandidate } from "./schema-effective-candidate";
import type { RegisteredSchemaAnchor } from "./schema-registry";

export function assertCoverage(
  entries: Record<string, unknown>,
  anchors: readonly RegisteredSchemaAnchor[],
): void {
  for (const key of Object.keys(entries)) {
    if (key === "_weaver") continue;
    if (
      !anchors.some(
        (anchor) => parseCanonicalConfigPath(anchor.path).segments[0] === key,
      )
    )
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Unregistered configuration root",
        { key },
      );
  }
}

export function validateSparseLayer(
  entries: Record<string, unknown>,
  anchors: readonly RegisteredSchemaAnchor[],
): void {
  assertCoverage(entries, anchors);
  for (const anchor of anchors) {
    const path = parseCanonicalConfigPath(anchor.path);
    const value = deepGet(entries, path.storageKey);
    if (value === undefined) continue;
    const result = validateLayerConfiguration(anchor.schema, value, {
      path: path.segments,
    });
    if (!result.valid)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Sparse layer violates its declared schema",
        { errors: result.errors },
      );
  }
}

export function validateCoveredEffective(
  entries: Record<string, unknown>,
  anchors: readonly RegisteredSchemaAnchor[],
): Record<string, unknown> {
  assertCoverage(entries, anchors);
  const candidate = evaluateEffectiveCandidate(anchors, entries);
  if (!candidate.valid)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Effective configuration violates its declared schema",
      { errors: candidate.errors },
    );
  return candidate.entries;
}
