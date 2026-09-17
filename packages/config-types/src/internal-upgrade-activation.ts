import { z } from "zod";
import { builtinCatalogReferenceSchema } from "./internal-config";
import {
  canonicalInternalJson,
  internalDigestSchema,
  internalIdSchema,
} from "./internal-identities";
import { sha256Hex } from "./internal-sha256";
import {
  layerCommitReceiptSchema,
  providerRevisionSchema,
} from "./provider-authority";
import { scopeInstanceSchema } from "./schemas-layers";

const terminalSchema = z.enum(["completed", "restart-required"]);
const controlBindingSchema = z.strictObject({
  providerId: internalIdSchema,
  namespace: z.string().min(1),
  revision: providerRevisionSchema,
});
const targetBindingSchema = z.strictObject({
  planId: internalDigestSchema,
  catalogDigest: internalDigestSchema,
  builtinCatalog: builtinCatalogReferenceSchema,
  sourceInfrastructureGeneration: internalIdSchema,
  targetInfrastructureGeneration: internalIdSchema,
});
const finalContextLayerSchema = z.strictObject({
  providerId: internalIdSchema,
  namespace: z.string().min(1).max(512),
  revision: providerRevisionSchema,
  contentDigest: internalDigestSchema,
});
const finalContextSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]+$/),
  scopePath: z.array(scopeInstanceSchema).readonly(),
  authorityVector: z.array(internalDigestSchema).min(1).max(1024).readonly(),
  deliveredDigest: internalDigestSchema,
});
export const validatedFinalContextsBindingSchema = z
  .strictObject({
    version: z.literal(1),
    runId: z.uuid(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    aggregateDigest: internalDigestSchema,
    planId: internalDigestSchema,
    targetCatalogDigest: internalDigestSchema,
    layers: z.array(finalContextLayerSchema).min(1).max(1024).readonly(),
    contexts: z.array(finalContextSchema).min(1).max(4096).readonly(),
  })
  .superRefine((binding, context) => {
    if (!isCanonicalUnique(binding.layers, layerIdentity))
      context.addIssue({
        code: "custom",
        message: "Final context layers are not canonical",
      });
    if (
      !isCanonicalUnique(binding.contexts, (item) =>
        canonicalInternalJson(item.scopePath),
      ) ||
      new Set(binding.contexts.map((item) => item.id)).size !==
        binding.contexts.length
    )
      context.addIssue({
        code: "custom",
        message: "Final contexts are not canonical",
      });
    const vector = binding.layers.map((layer) =>
      layerCommitment(binding.runId, layer),
    );
    if (
      binding.contexts.some(
        (item) =>
          canonicalInternalJson(item.authorityVector) !==
          canonicalInternalJson(vector),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Final context authority vector mismatch",
      });
    if (binding.aggregateDigest !== validatedFinalContextsDigest(binding))
      context.addIssue({
        code: "custom",
        message: "Final context aggregate mismatch",
      });
  });
const intentFields = {
  operationId: z.uuid(),
  control: controlBindingSchema,
  target: targetBindingSchema,
  prestateDigest: internalDigestSchema,
  mutationDigest: internalDigestSchema,
  candidateDigest: internalDigestSchema,
  finalContexts: validatedFinalContextsBindingSchema,
  terminal: terminalSchema,
};

export const upgradeActivationSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("pending") }),
    z.strictObject({ status: z.literal("intent"), ...intentFields }),
    z.strictObject({
      status: z.literal("complete"),
      ...intentFields,
      poststateDigest: internalDigestSchema,
      receipt: layerCommitReceiptSchema,
    }),
  ])
  .superRefine((activation, context) => {
    if (activation.status !== "complete") return;
    const receipt = activation.receipt;
    const expected = activation.control.revision;
    if (
      activation.operationId !== receipt.operationId ||
      expected.storeId !== receipt.previousRevision.storeId ||
      expected.environment !== receipt.previousRevision.environment ||
      expected.layer !== receipt.previousRevision.layer ||
      expected.epoch !== receipt.previousRevision.epoch ||
      receipt.previousRevision.storeId !== receipt.revision.storeId ||
      receipt.previousRevision.environment !== receipt.revision.environment ||
      receipt.previousRevision.layer !== receipt.revision.layer ||
      receipt.previousRevision.epoch !== receipt.revision.epoch ||
      !isNext(receipt.previousRevision.sequence, receipt.revision.sequence) ||
      activation.poststateDigest !== activation.candidateDigest
    )
      context.addIssue({
        code: "custom",
        message: "Activation completion lineage mismatch",
      });
  });

function isNext(previous: string, next: string): boolean {
  try {
    return BigInt(next) === BigInt(previous) + 1n;
  } catch {
    return false;
  }
}

export type UpgradeActivation = z.infer<typeof upgradeActivationSchema>;
export type ValidatedFinalContextsBinding = z.infer<
  typeof validatedFinalContextsBindingSchema
>;

export function validatedFinalContextsDigest(
  binding:
    | Omit<ValidatedFinalContextsBinding, "aggregateDigest">
    | ValidatedFinalContextsBinding,
): string {
  const unsigned = withoutAggregate(binding);
  return sha256Hex(
    canonicalInternalJson({
      domain: "weaver.validated-final-contexts.v2",
      ...structuredClone(unsigned),
    }),
  );
}

function withoutAggregate(
  binding:
    | Omit<ValidatedFinalContextsBinding, "aggregateDigest">
    | ValidatedFinalContextsBinding,
): Omit<ValidatedFinalContextsBinding, "aggregateDigest"> {
  if (!("aggregateDigest" in binding)) return binding;
  const { aggregateDigest: _aggregateDigest, ...unsigned } = binding;
  return unsigned;
}

function layerIdentity(layer: z.infer<typeof finalContextLayerSchema>): string {
  return canonicalInternalJson([
    layer.providerId,
    layer.namespace,
    layer.revision.storeId,
    layer.revision.environment,
    layer.revision.layer,
  ]);
}

function layerCommitment(
  runId: string,
  layer: z.infer<typeof finalContextLayerSchema>,
): string {
  return sha256Hex(
    canonicalInternalJson({
      domain: "weaver.final-context-layer.v2",
      runId,
      layer,
    }),
  );
}

function isCanonicalUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
): boolean {
  const identities = values.map(identity);
  return (
    new Set(identities).size === identities.length &&
    identities.every(
      (value, index) =>
        index === 0 || value.localeCompare(identities[index - 1] ?? "") > 0,
    )
  );
}
