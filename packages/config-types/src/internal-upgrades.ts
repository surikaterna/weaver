import { z } from "zod";
import { builtinCatalogReferenceSchema } from "./internal-config";
import {
  canonicalInternalJson,
  internalDigestSchema,
  internalIdSchema,
} from "./internal-identities";
import { upgradeActivationSchema } from "./internal-upgrade-activation";
import {
  internalUpgradeMutationSchema,
  internalUpgradePlanSchema,
  internalUpgradeTargetSchema,
} from "./internal-upgrade-plan";
import {
  layerCommitReceiptSchema,
  providerRevisionSchema,
} from "./provider-authority";

export {
  type UpgradeActivation,
  upgradeActivationSchema,
  type ValidatedFinalContextsBinding,
  validatedFinalContextsBindingSchema,
  validatedFinalContextsDigest,
} from "./internal-upgrade-activation";

const stepFields = {
  id: internalIdSchema,
  target: internalUpgradeTargetSchema,
  operationId: z.uuid(),
  preRevision: providerRevisionSchema,
  preDigest: internalDigestSchema,
  postDigest: internalDigestSchema,
  mutation: internalUpgradeMutationSchema,
  undo: internalUpgradeMutationSchema.optional(),
};
export const INTERNAL_RECOVERY_MAX_BYTES = 4_000_000;
export const INTERNAL_RECOVERY_MAX_STEPS = 1000;
const commonStep = z.strictObject(stepFields);
const pendingStep = z
  .strictObject({
    ...stepFields,
    status: z.literal("pending"),
  })
  .superRefine(checkStepBinding);
const intentStep = z
  .strictObject({
    ...stepFields,
    status: z.literal("intent"),
    intentOperationId: z.uuid(),
  })
  .superRefine(checkStepBinding);
const completeStep = z
  .strictObject({
    ...stepFields,
    status: z.literal("complete"),
    intentOperationId: z.uuid(),
    receipt: layerCommitReceiptSchema,
    compensation: z
      .discriminatedUnion("status", [
        z.strictObject({ status: z.literal("pending") }),
        z.strictObject({
          status: z.literal("intent"),
          operationId: z.uuid(),
        }),
        z.strictObject({
          status: z.literal("complete"),
          operationId: z.uuid(),
          receipt: layerCommitReceiptSchema,
        }),
      ])
      .optional(),
  })
  .superRefine((step, context) => {
    checkStepBinding(step, context);
    if (
      step.operationId !== step.receipt.operationId ||
      step.target.storeId !== step.receipt.revision.storeId ||
      step.target.layer !== step.receipt.revision.layer ||
      step.preRevision.environment !== step.receipt.revision.environment ||
      step.preRevision.storeId !== step.receipt.previousRevision.storeId ||
      step.preRevision.layer !== step.receipt.previousRevision.layer ||
      step.preRevision.environment !==
        step.receipt.previousRevision.environment ||
      step.preRevision.epoch !== step.receipt.previousRevision.epoch ||
      step.preRevision.epoch !== step.receipt.revision.epoch ||
      !isNextSequence(
        step.preRevision.sequence,
        step.receipt.previousRevision.sequence,
        step.receipt.revision.sequence,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Recovery receipt identity mismatch",
      });
  });
const compensatingStep = z.union([pendingStep, intentStep, completeStep]);
export const internalRecoveryStepSchema = z.discriminatedUnion("status", [
  pendingStep,
  intentStep,
  completeStep,
]);
export type InternalRecoveryStep = z.infer<typeof internalRecoveryStepSchema>;

function checkStepBinding(
  step: z.infer<typeof commonStep>,
  context: z.RefinementCtx,
): void {
  if (
    step.target.storeId !== step.preRevision.storeId ||
    step.target.layer !== step.preRevision.layer
  )
    context.addIssue({
      code: "custom",
      message: "Recovery target/revision identity mismatch",
    });
  if (step.preDigest === step.postDigest)
    context.addIssue({
      code: "custom",
      message: "Semantic no-op steps must be omitted",
    });
}

function isNextSequence(pre: string, previous: string, next: string): boolean {
  try {
    return (
      BigInt(previous) >= BigInt(pre) && BigInt(next) === BigInt(previous) + 1n
    );
  } catch {
    return false;
  }
}

const adoptionSchema = z.strictObject({
  previousOwner: z.uuid(),
  adoptedBy: z.uuid(),
  priorOwnerStopped: z.strictObject({
    observedAt: z.iso.datetime(),
    evidence: z.string().min(1).max(2048),
  }),
});
const journalFields = {
  version: z.literal(1),
  runId: z.uuid(),
  planId: internalDigestSchema,
  source: builtinCatalogReferenceSchema,
  target: builtinCatalogReferenceSchema,
  infrastructureGeneration: internalIdSchema,
  owner: z.uuid(),
  sourceRevisions: z
    .array(
      z.strictObject({
        providerId: internalIdSchema,
        revision: providerRevisionSchema,
      }),
    )
    .readonly()
    .optional(),
  control: z
    .strictObject({
      providerId: internalIdSchema,
      revision: providerRevisionSchema,
      receipts: z.array(layerCommitReceiptSchema).max(4000).readonly(),
      operationId: z.uuid(),
    })
    .optional(),
  adoption: adoptionSchema.optional(),
};
const cursorSchema = z
  .array(
    z.strictObject({
      providerId: internalIdSchema,
      revision: providerRevisionSchema,
    }),
  )
  .min(1)
  .readonly();
const failureSchema = z.strictObject({
  code: z.enum([
    "conflict",
    "unknown-commit",
    "validation",
    "ownership",
    "storage",
    "operator-required",
  ]),
  message: z.string().min(1).max(2048),
  stepId: internalIdSchema.optional(),
});
/** Pinned version-1 recovery envelope: independent of the active or target application catalog. */
export const internalRecoveryEnvelopeSchema = z
  .discriminatedUnion("phase", [
    z.strictObject({
      ...journalFields,
      phase: z.literal("prepared"),
      steps: z.array(pendingStep).max(INTERNAL_RECOVERY_MAX_STEPS).readonly(),
      activation: z.strictObject({ status: z.literal("pending") }).optional(),
    }),
    z.strictObject({
      ...journalFields,
      phase: z.literal("applying"),
      steps: z
        .array(compensatingStep)
        .max(INTERNAL_RECOVERY_MAX_STEPS)
        .readonly(),
      cursor: cursorSchema,
      activation: upgradeActivationSchema.optional(),
    }),
    z.strictObject({
      ...journalFields,
      phase: z.literal("verifying"),
      steps: z.array(completeStep).max(INTERNAL_RECOVERY_MAX_STEPS).readonly(),
      cursor: cursorSchema,
      activation: upgradeActivationSchema.optional(),
    }),
    z.strictObject({
      ...journalFields,
      phase: z.literal("completed"),
      steps: z.array(completeStep).max(INTERNAL_RECOVERY_MAX_STEPS).readonly(),
      cursor: cursorSchema,
      activation: upgradeActivationSchema.optional(),
    }),
    z.strictObject({
      ...journalFields,
      phase: z.literal("blocked"),
      steps: z
        .array(compensatingStep)
        .max(INTERNAL_RECOVERY_MAX_STEPS)
        .readonly(),
      cursor: cursorSchema.optional(),
      failure: failureSchema,
      activation: upgradeActivationSchema.optional(),
    }),
    z.strictObject({
      ...journalFields,
      phase: z.literal("compensating"),
      steps: z
        .array(internalRecoveryStepSchema)
        .max(INTERNAL_RECOVERY_MAX_STEPS)
        .readonly(),
      cursor: cursorSchema,
      activation: upgradeActivationSchema.optional(),
    }),
    z.strictObject({
      ...journalFields,
      phase: z.literal("compensated"),
      steps: z
        .array(internalRecoveryStepSchema)
        .max(INTERNAL_RECOVERY_MAX_STEPS)
        .readonly(),
      cursor: cursorSchema,
      activation: upgradeActivationSchema.optional(),
    }),
    z.strictObject({
      ...journalFields,
      phase: z.literal("restart-required"),
      steps: z.array(completeStep).max(INTERNAL_RECOVERY_MAX_STEPS).readonly(),
      cursor: cursorSchema,
      activation: upgradeActivationSchema.optional(),
    }),
  ])
  .superRefine((journal, context) => {
    if (
      new TextEncoder().encode(canonicalInternalJson(journal)).byteLength >
      INTERNAL_RECOVERY_MAX_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Recovery envelope exceeds code-pinned size bound",
      });
    checkRecoveryOrder(journal.steps, context);
    if (
      new Set(journal.steps.map((step) => step.id)).size !==
      journal.steps.length
    )
      context.addIssue({ code: "custom", message: "Duplicate recovery step" });
    if (
      new Set(journal.steps.map((step) => step.operationId)).size !==
      journal.steps.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate recovery operation",
      });
  });
export type InternalRecoveryEnvelope = z.infer<
  typeof internalRecoveryEnvelopeSchema
>;

function checkRecoveryOrder(
  steps: readonly InternalRecoveryStep[],
  context: z.RefinementCtx,
): void {
  let rank = 0;
  let intents = 0;
  for (const step of steps) {
    const next =
      step.status === "complete" ? 0 : step.status === "intent" ? 1 : 2;
    if (next < rank)
      context.addIssue({
        code: "custom",
        message:
          "Recovery steps must be a completed prefix, optional intent, then pending suffix",
      });
    rank = next;
    if (step.status === "intent") intents++;
  }
  if (intents > 1)
    context.addIssue({
      code: "custom",
      message: "Only one recovery intent may be outstanding",
    });
}

export const internalUpgradesSchema = z
  .strictObject({
    plans: z.record(internalDigestSchema, internalUpgradePlanSchema),
    journal: z.record(z.uuid(), internalRecoveryEnvelopeSchema),
  })
  .superRefine((value, context) => {
    for (const [id, plan] of Object.entries(value.plans))
      if (id !== plan.id)
        context.addIssue({
          code: "custom",
          message: "Plan record identity mismatch",
        });
    for (const [id, journal] of Object.entries(value.journal))
      if (id !== journal.runId)
        context.addIssue({
          code: "custom",
          message: "Journal record identity mismatch",
        });
  });
export type InternalUpgrades = z.infer<typeof internalUpgradesSchema>;
