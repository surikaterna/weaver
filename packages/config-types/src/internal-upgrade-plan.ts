import { z } from "zod";
import { environmentNameSchema } from "./environment";
import {
  builtinCatalogReferenceSchema,
  internalRegistrationRecordSchema,
} from "./internal-config";
import {
  canonicalInternalJson,
  internalDigestSchema,
  internalIdSchema,
  internalRecordIdSchema,
} from "./internal-identities";
import { sha256Hex } from "./internal-sha256";
import {
  authoritySequenceSchema,
  providerRevisionSchema,
} from "./provider-authority";
import { scopeInstanceSchema } from "./schemas-layers";

export const internalUpgradeTargetSchema = z.strictObject({
  providerId: internalIdSchema,
  namespace: z.string().min(1),
  storeId: z.string().min(1),
  layer: z.string().min(1),
  path: z
    .string()
    .regex(/^\/[^/[\]]+(?:\/[^/[\]]+)*$/)
    .refine(
      (path) =>
        !path
          .split("/")
          .some((part) =>
            ["__proto__", "constructor", "prototype"].includes(part),
          ),
      "Unsafe target path",
    ),
});
export type InternalUpgradeTarget = z.infer<typeof internalUpgradeTargetSchema>;

/** Explicit raw config payload, not an extensible metadata catchall or resolved secret snapshot. */
export const internalUpgradeMutationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("set"), value: z.json() }),
  z.strictObject({ action: z.literal("remove") }),
]);
export type InternalUpgradeMutation = z.infer<
  typeof internalUpgradeMutationSchema
>;
export const internalUpgradeStepSchema = z
  .strictObject({
    id: internalIdSchema,
    target: internalUpgradeTargetSchema,
    expectedRevision: providerRevisionSchema,
    preDigest: internalDigestSchema,
    postDigest: internalDigestSchema,
    mutation: internalUpgradeMutationSchema,
    reversible: z.boolean(),
    undo: internalUpgradeMutationSchema.optional(),
  })
  .superRefine((step, context) => {
    if (
      step.target.storeId !== step.expectedRevision.storeId ||
      step.target.layer !== step.expectedRevision.layer
    )
      context.addIssue({
        code: "custom",
        message: "Upgrade target/revision identity mismatch",
      });
    if (step.reversible !== (step.undo !== undefined))
      context.addIssue({
        code: "custom",
        message: "Reversible steps require exactly one recorded undo",
      });
    if (step.preDigest === step.postDigest)
      context.addIssue({
        code: "custom",
        message: "Semantic no-op steps must be omitted",
      });
  });
export type InternalUpgradeStep = z.infer<typeof internalUpgradeStepSchema>;

export const internalUpgradeFinalLayerSchema = z.strictObject({
  providerId: internalIdSchema,
  namespace: z.string().min(1),
  storeId: z.string().min(1),
  environment: environmentNameSchema,
  layer: z.string().min(1),
  contentDomain: z.enum(["layer-entries-v1", "control-application-v1"]),
  sourceDigest: internalDigestSchema,
  finalDigest: internalDigestSchema,
});
export type InternalUpgradeFinalLayer = z.infer<
  typeof internalUpgradeFinalLayerSchema
>;

export const internalUpgradeSourceSchema = z.strictObject({
  catalogDigest: internalDigestSchema,
  dataDigests: z
    .array(
      z.strictObject({
        providerId: internalIdSchema,
        namespace: z.string().min(1),
        storeId: z.string().min(1),
        layer: z.string().min(1),
        contentDomain: z.enum(["layer-entries-v1", "control-application-v1"]),
        digest: internalDigestSchema,
      }),
    )
    .readonly(),
  providerRevisions: z
    .array(
      z.strictObject({
        providerId: internalIdSchema,
        revisions: z.array(providerRevisionSchema).readonly(),
      }),
    )
    .readonly(),
  inventoryRevision: authoritySequenceSchema,
  infrastructureGeneration: internalIdSchema,
});
export const internalUpgradeDestinationSchema = z.strictObject({
  catalogDigest: internalDigestSchema,
  registrations: z
    .record(internalRecordIdSchema, internalRegistrationRecordSchema)
    .optional(),
  builtinCatalog: builtinCatalogReferenceSchema.optional(),
  infrastructureGeneration: internalIdSchema.optional(),
});
export const internalUpgradePlanSchema = z
  .strictObject({
    version: z.literal(1),
    id: internalDigestSchema,
    source: internalUpgradeSourceSchema,
    target: internalUpgradeDestinationSchema,
    contexts: z.array(z.array(scopeInstanceSchema).readonly()).readonly(),
    steps: z.array(internalUpgradeStepSchema).readonly(),
    finalLayers: z.array(internalUpgradeFinalLayerSchema).min(1).readonly(),
    refusals: z.array(z.never()).max(0).readonly(),
  })
  .superRefine(checkUpgradePlan);
export type InternalUpgradePlan = z.infer<typeof internalUpgradePlanSchema>;

function checkUpgradePlan(
  plan: {
    readonly id: string;
    readonly source: z.infer<typeof internalUpgradeSourceSchema>;
    readonly steps: readonly {
      readonly id: string;
      readonly target: InternalUpgradeTarget;
    }[];
    readonly finalLayers: readonly InternalUpgradeFinalLayer[];
  } & Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  if (new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length)
    context.addIssue({ code: "custom", message: "Duplicate upgrade step" });
  const layerIds = plan.finalLayers.map(finalLayerIdentity);
  if (
    new Set(layerIds).size !== layerIds.length ||
    layerIds.some(
      (id, index) =>
        index > 0 && id.localeCompare(layerIds[index - 1] ?? "") <= 0,
    )
  )
    context.addIssue({
      code: "custom",
      message: "Final layer bindings must be unique and canonically ordered",
    });
  checkFinalLayerCoverage(plan, context);
  const { id, ...body } = plan;
  if (id !== sha256Hex(canonicalInternalJson(body)))
    context.addIssue({
      code: "custom",
      message: "Upgrade plan identity mismatch",
    });
}

function checkFinalLayerCoverage(
  plan: {
    readonly source: z.infer<typeof internalUpgradeSourceSchema>;
    readonly steps: readonly { readonly target: InternalUpgradeTarget }[];
    readonly finalLayers: readonly InternalUpgradeFinalLayer[];
  },
  context: z.RefinementCtx,
): void {
  const revisions = new Map(
    plan.source.providerRevisions.flatMap((provider) =>
      provider.revisions.map(
        (revision) =>
          [
            sourceLayerIdentity(provider.providerId, revision.layer),
            revision,
          ] as const,
      ),
    ),
  );
  const bindings = new Map(
    plan.finalLayers.map((layer) => [
      sourceLayerIdentity(layer.providerId, layer.layer),
      layer,
    ]),
  );
  const digests = new Map(
    plan.source.dataDigests.map((item) => [
      sourceLayerIdentity(item.providerId, item.layer),
      item,
    ]),
  );
  const revisionCount = plan.source.providerRevisions.reduce(
    (count, provider) => count + provider.revisions.length,
    0,
  );
  const valid =
    revisions.size === revisionCount &&
    revisions.size === plan.source.dataDigests.length &&
    revisions.size === plan.finalLayers.length &&
    [...revisions].every(([id, revision]) => {
      const binding = bindings.get(id);
      const digest = digests.get(id);
      return (
        binding?.storeId === revision.storeId &&
        binding.environment === revision.environment &&
        digest?.storeId === revision.storeId &&
        binding.namespace === digest.namespace &&
        binding.contentDomain === digest.contentDomain &&
        binding.sourceDigest === digest.digest
      );
    }) &&
    plan.steps.every((step) =>
      bindings.has(
        sourceLayerIdentity(step.target.providerId, step.target.layer),
      ),
    );
  if (!valid)
    context.addIssue({
      code: "custom",
      message: "Final layer bindings must completely match source authority",
    });
}

export type InternalUpgradeContentDomain =
  InternalUpgradeFinalLayer["contentDomain"];

export function internalUpgradeLayerDigest(
  entries: Readonly<Record<string, unknown>>,
  domain: InternalUpgradeContentDomain,
): string {
  const projected = { ...structuredClone(entries) };
  if (domain === "control-application-v1") delete projected._weaver;
  return sha256Hex(canonicalInternalJson({ domain, entries: projected }));
}

function finalLayerIdentity(layer: InternalUpgradeFinalLayer): string {
  return canonicalInternalJson([
    layer.providerId,
    layer.namespace,
    layer.storeId,
    layer.environment,
    layer.layer,
  ]);
}

function sourceLayerIdentity(providerId: string, layer: string): string {
  return canonicalInternalJson([providerId, layer]);
}

export const internalUpgradeRefusalSchema = z.strictObject({
  code: z.enum([
    "missing-default",
    "invalid-default",
    "invalid-existing-value",
    "incomplete-inventory",
    "unsupported-authority",
    "ambiguous-placement",
    "readonly-target",
    "unverifiable-secret",
    "stale-binding",
    "explicit-disposition-required",
    "unsupported-governance",
    "unsafe-overwrite",
  ]),
  message: z.string().min(1),
  path: z.string().optional(),
  context: z.array(scopeInstanceSchema).readonly().optional(),
  target: internalUpgradeTargetSchema.optional(),
});
export type InternalUpgradeRefusal = z.infer<
  typeof internalUpgradeRefusalSchema
>;
export const internalUpgradePlanResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    plan: internalUpgradePlanSchema,
  }),
  z.strictObject({
    status: z.literal("blocked"),
    refusals: z.array(internalUpgradeRefusalSchema).min(1).readonly(),
  }),
]);
export type InternalUpgradePlanResult = z.infer<
  typeof internalUpgradePlanResultSchema
>;
