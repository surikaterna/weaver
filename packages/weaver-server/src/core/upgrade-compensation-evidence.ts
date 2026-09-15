import { deepEqual, deepGet } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  type LayerCommitRequest,
  type LayerEnvelope,
  type ProviderRevision,
} from "@weaver-conf/config-types";
import {
  computeProviderMutationDigest,
  getProviderRevision,
} from "@weaver-conf/storage-providers";
import { transitionDigest } from "./schema-transition";
import { stepKey } from "./upgrade-execution-support";

export type CompleteStep = Extract<
  InternalRecoveryEnvelope["steps"][number],
  { status: "complete" }
>;
export type LayerCommitReceipt = NonNullable<LayerEnvelope["lastCommit"]>;

export function assertCompensationOrder(steps: readonly CompleteStep[]): void {
  let foundIncomplete = false;
  for (const step of steps) {
    if (step.compensation?.status === "complete") {
      if (foundIncomplete)
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Compensation receipts are not in reverse step order",
        );
      continue;
    }
    foundIncomplete = true;
  }
}

export function assertCompensationStepBinding(
  planned: InternalUpgradePlan["steps"][number],
  recorded: CompleteStep,
): void {
  if (
    planned.id !== recorded.id ||
    !deepEqual(planned.target, recorded.target) ||
    planned.preDigest !== recorded.preDigest ||
    planned.postDigest !== recorded.postDigest ||
    !deepEqual(planned.mutation, recorded.mutation) ||
    !deepEqual(planned.undo, recorded.undo)
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Compensation plan and journal lineage differ",
    );
}

export function compensationCursor(journal: InternalRecoveryEnvelope) {
  const cursor = "cursor" in journal ? journal.cursor : journal.sourceRevisions;
  if (!cursor?.length)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Compensation cursor is missing",
    );
  return cursor;
}

export function compensationRevision(
  journal: InternalRecoveryEnvelope,
  planned: InternalUpgradePlan["steps"][number],
): ProviderRevision {
  const cursor = compensationCursor(journal).find(
    (item) =>
      item.providerId === planned.target.providerId &&
      item.revision.layer === planned.target.layer,
  );
  if (!cursor)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Compensation cursor is missing",
    );
  return cursor.revision;
}

export function exactCompensationPrestate(
  journal: InternalRecoveryEnvelope,
  planned: InternalUpgradePlan["steps"][number],
  recorded: CompleteStep,
  expected: ProviderRevision,
  envelope: LayerEnvelope,
): boolean {
  return (
    deepEqual(getProviderRevision(envelope), expected) &&
    deepEqual(envelope.lastCommit, priorReceipt(journal, expected)) &&
    targetDigest(envelope, planned) === recorded.postDigest
  );
}

export function exactCompensationReceipt(
  planned: InternalUpgradePlan["steps"][number],
  recorded: CompleteStep,
  expected: ProviderRevision,
  operationId: string,
  envelope: LayerEnvelope,
): LayerCommitReceipt | undefined {
  const receipt = envelope.lastCommit;
  if (!receipt || receipt.operationId !== operationId) return undefined;
  const request = compensationRequest(planned, expected, operationId);
  return deepEqual(receipt.previousRevision, expected) &&
    deepEqual(receipt.revision, getProviderRevision(envelope)) &&
    receipt.mutationDigest === computeProviderMutationDigest(request) &&
    targetDigest(envelope, planned) === recorded.preDigest
    ? receipt
    : undefined;
}

function priorReceipt(
  journal: InternalRecoveryEnvelope,
  revision: ProviderRevision,
): LayerCommitReceipt {
  const receipts = journal.steps.flatMap((step) => {
    if (step.status !== "complete") return [];
    return [
      step.receipt,
      ...(step.compensation?.status === "complete"
        ? [step.compensation.receipt]
        : []),
    ];
  });
  const receipt = receipts.find((item) => deepEqual(item.revision, revision));
  if (!receipt)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Compensation cursor has no authoritative receipt",
    );
  return receipt;
}

function compensationRequest(
  planned: InternalUpgradePlan["steps"][number],
  expectedRevision: ProviderRevision,
  operationId: string,
): LayerCommitRequest {
  const undo = planned.undo;
  if (!undo)
    throw createWeaverError("VALIDATION_ERROR", "Compensation undo is missing");
  return {
    layer: planned.target.layer,
    expectedRevision,
    operationId,
    mutation:
      undo.action === "set"
        ? { action: "set", key: stepKey(planned), value: undo.value }
        : { action: "remove", key: stepKey(planned) },
  };
}

function targetDigest(
  envelope: LayerEnvelope,
  planned: InternalUpgradePlan["steps"][number],
): string {
  const value = deepGet(envelope.entries, stepKey(planned));
  return transitionDigest({
    absent: value === undefined,
    ...(value === undefined ? {} : { value }),
  });
}
