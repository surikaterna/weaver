import { randomUUID } from "node:crypto";
import { deepEqual } from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalRecoveryEnvelope,
  internalRecoveryEnvelopeSchema,
  type LayerEnvelope,
  type ProviderRevision,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { controlProjection, hostForControl } from "./config-service-internal";
import type { WeaverConfigService } from "./config-service-types";

type LayerCommitReceipt = NonNullable<LayerEnvelope["lastCommit"]>;

export function assertCurrentJournalReceipt(
  envelope: LayerEnvelope,
  journal: InternalRecoveryEnvelope,
): void {
  const control = requiredControl(journal);
  const previous = control.receipts.at(-1)?.revision ?? control.revision;
  const digest = computeProviderMutationDigest({
    layer: previous.layer,
    expectedRevision: previous,
    operationId: control.operationId,
    mutation: {
      action: "set",
      key: `_weaver.upgrades.journal.${journal.runId}`,
      value: JSON.parse(canonicalInternalJson(journal)),
    },
  });
  if (!exactReceipt(envelope.lastCommit, control.operationId, digest, previous))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Current recovery journal does not match durable receipt lineage",
    );
}

export async function prepareInitialJournal(
  service: WeaverConfigService,
  journal: InternalRecoveryEnvelope,
): Promise<InternalRecoveryEnvelope> {
  const control = requiredControl(journal);
  const plan =
    controlProjection(service).prepared().configuration.upgrades.plans[
      journal.planId
    ];
  if (!plan)
    throw createWeaverError("VALIDATION_ERROR", "Upgrade plan is missing");
  const receipt = await exactLatestReceipt(
    service,
    control.providerId,
    control.revision,
    undefined,
    `_weaver.upgrades.plans.${plan.id}`,
    plan,
  );
  return parseJournal({
    ...journal,
    control: {
      ...control,
      receipts: [receipt],
      operationId: randomUUID(),
    },
  });
}

export async function prepareJournalReplacement(
  service: WeaverConfigService,
  previous: InternalRecoveryEnvelope,
  candidate: InternalRecoveryEnvelope,
  operationId: string,
): Promise<InternalRecoveryEnvelope> {
  const control = requiredControl(previous);
  const receipt = await exactLatestReceipt(
    service,
    control.providerId,
    control.receipts.at(-1)?.revision ?? control.revision,
    control.operationId,
    `_weaver.upgrades.journal.${previous.runId}`,
    previous,
  );
  return parseJournal({
    ...candidate,
    ...cursorUpdate(candidate, control.providerId, receipt.revision),
    control: {
      ...control,
      receipts: [...control.receipts, receipt],
      operationId,
    },
  });
}

function cursorUpdate(
  journal: InternalRecoveryEnvelope,
  providerId: string,
  revision: ProviderRevision,
) {
  if (!("cursor" in journal) || !journal.cursor) return {};
  return {
    cursor: journal.cursor.map((entry) =>
      entry.providerId === providerId && entry.revision.layer === revision.layer
        ? { providerId, revision }
        : entry,
    ),
  };
}

async function exactLatestReceipt(
  service: WeaverConfigService,
  providerId: string,
  previous: ProviderRevision,
  operationId: string | undefined,
  key: string,
  value: unknown,
): Promise<LayerCommitReceipt> {
  const provider = hostForControl(service).providers.find(
    (item) => item.id === providerId,
  );
  const envelope = await provider?.authority?.readLayer(previous.layer);
  const receipt = envelope?.lastCommit;
  const expectedOperation = operationId ?? receipt?.operationId;
  const digest = expectedOperation
    ? computeProviderMutationDigest({
        layer: previous.layer,
        expectedRevision: previous,
        operationId: expectedOperation,
        mutation: {
          action: "set",
          key,
          value: JSON.parse(canonicalInternalJson(value)),
        },
      })
    : undefined;
  if (!exactReceipt(receipt, expectedOperation, digest, previous))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Control journal persistence does not exactly continue durable lineage",
    );
  return receipt;
}

function exactReceipt(
  receipt: LayerCommitReceipt | undefined,
  operationId: string | undefined,
  digest: string | undefined,
  previous: ProviderRevision,
): receipt is LayerCommitReceipt {
  return Boolean(
    receipt &&
      receipt.operationId === operationId &&
      receipt.mutationDigest === digest &&
      deepEqual(receipt.previousRevision, previous) &&
      sameAuthority(previous, receipt.revision) &&
      BigInt(receipt.revision.sequence) === BigInt(previous.sequence) + 1n,
  );
}

function requiredControl(journal: InternalRecoveryEnvelope) {
  if (!journal.control)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Control journal binding is missing",
    );
  return journal.control;
}

function sameAuthority(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return deepEqual({ ...left, sequence: right.sequence }, right);
}

function parseJournal(value: unknown): InternalRecoveryEnvelope {
  return internalRecoveryEnvelopeSchema.parse(value);
}
