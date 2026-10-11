import {
  deepGet,
  parseCanonicalConfigPath,
  type ResolutionCeiling,
  resolutionCeilingSchema,
  resolutionLayerSchema,
} from "@weaver-conf/config-engine";
import {
  createWeaverError,
  isReservedPathSegment,
  type ObjectConfigurationPropertySchema,
  objectConfigurationPropertySchemaSchema,
  weaverPropertyExtensionsSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import { ceilingPaths } from "./registered-ceiling-paths";
import type { RegistryProjectionReader } from "./registry-contracts";
import { encodeSchemaGraph } from "./schema-graph-codec";

export const registeredCeilingInputSchema = z
  .strictObject({
    environment: z.string().min(1),
    registryRevision: z.number().int().nonnegative(),
    layerNames: z.array(z.string().min(1)).min(1).readonly(),
    candidates: z.array(resolutionLayerSchema).readonly(),
  })
  .readonly();
export type RegisteredCeilingInput = z.infer<
  typeof registeredCeilingInputSchema
>;
export const registeredCeilingEvidenceSchema = z
  .strictObject({
    environment: z.string().min(1),
    registryRevision: z.number().int().nonnegative(),
    ceilings: z.array(resolutionCeilingSchema).readonly(),
  })
  .readonly();
export type RegisteredCeilingEvidence = z.infer<
  typeof registeredCeilingEvidenceSchema
>;

/** Uses the native schema graph, including inactive branches, not payload objects. */
export function validateRegisteredCeilingNames(
  schema: ObjectConfigurationPropertySchema,
  layerNames: readonly string[],
): void {
  const parsed = objectConfigurationPropertySchemaSchema.safeParse(schema);
  if (!parsed.success) invalidCeiling();
  const nodes = encodeSchemaGraph(parsed.data).nodes;
  for (const node of nodes) {
    if (node["x-weaver"] === undefined) continue;
    const metadata = weaverPropertyExtensionsSchema.parse(node["x-weaver"]);
    if (metadata.maxOverrideLayer === undefined) continue;
    knownRank(layerNames, metadata.maxOverrideLayer);
  }
}

export function registeredCeilingEvidence(
  reader: RegistryProjectionReader,
  input: RegisteredCeilingInput,
): RegisteredCeilingEvidence {
  const parsed = registeredCeilingInputSchema.safeParse(input);
  if (!parsed.success) invalidCeiling();
  const context = parsed.data;
  if (new Set(context.layerNames).size !== context.layerNames.length)
    invalidCeiling();
  for (const layer of context.candidates) {
    if (knownRank(context.layerNames, layer.layer) !== layer.rank)
      invalidCeiling();
  }
  const ceilings: ResolutionCeiling[] = [];
  for (const identity of reader.listRegisteredSchemaIdentities().anchors) {
    if (identity.environment !== context.environment) continue;
    const anchor = reader.resolveAnchor(identity.path, identity.environment);
    if (!anchor) invalidCeiling();
    validateRegisteredCeilingNames(anchor.schema, context.layerNames);
    const root = parseCanonicalConfigPath(identity.path);
    const candidates = context.candidates.length
      ? context.candidates.map((layer) =>
          deepGet(layer.entries, root.storageKey),
        )
      : [undefined];
    for (const item of ceilingPaths(anchor.schema, candidates)) {
      const path = [...root.segments, ...item.path];
      if (path.some(isReservedPathSegment)) invalidCeiling();
      ceilings.push(
        Object.freeze({
          path: Object.freeze(path),
          maxRank: knownRank(context.layerNames, item.layer),
        }),
      );
    }
  }
  return Object.freeze({
    environment: context.environment,
    registryRevision: context.registryRevision,
    ceilings: Object.freeze(ceilings),
  });
}

function knownRank(names: readonly string[], name: string): number {
  const rank = names.indexOf(name);
  if (rank < 0) invalidCeiling();
  return rank;
}
function invalidCeiling(): never {
  throw createWeaverError(
    "VALIDATION_ERROR",
    "Invalid registered ceiling policy",
  );
}
