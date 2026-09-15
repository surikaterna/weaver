import {
  deepEqual,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalRecoveryStep,
  type LayerCommitRequest,
  type LayerEnvelope,
  type ProviderRevision,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";

type Receipt = NonNullable<LayerEnvelope["lastCommit"]>;
interface Timeline {
  readonly providerId: string;
  readonly baseline: ProviderRevision;
  readonly receipts: Receipt[];
}

/** Static evidence validation only; persisted receipts still require live ownership verification at recovery. */
export function validateBuiltinRecoveryEvidence(
  journal: InternalRecoveryEnvelope,
): void {
  const timelines = new Map<string, Timeline>();
  const sourceIds = new Set<string>();
  for (const source of journal.sourceRevisions ?? []) {
    const id = identity(source.providerId, source.revision);
    if (sourceIds.has(id)) fail("Duplicate recovery source revision");
    sourceIds.add(id);
    addBaseline(timelines, source.providerId, source.revision, true);
  }
  if (journal.control) {
    const control = addBaseline(
      timelines,
      journal.control.providerId,
      journal.control.revision,
      true,
    );
    control.receipts.push(...journal.control.receipts);
  }
  for (const step of journal.steps) {
    addStep(timelines, journal, step);
    addCompensation(timelines, step);
  }
  validateDeclaredDataOrder(journal.steps);
  validateCompensationOrder(journal.steps);
  validateEnvironments(timelines);
  const tips = new Map(
    [...timelines].map(([key, timeline]) => [key, validateTimeline(timeline)]),
  );
  if ("cursor" in journal && journal.cursor)
    validateCursor(journal.cursor, tips);
}

function addCompensation(
  timelines: Map<string, Timeline>,
  step: InternalRecoveryStep,
): void {
  if (step.status !== "complete" || step.compensation?.status !== "complete")
    return;
  const { operationId, receipt } = step.compensation;
  const undo = step.undo;
  if (!undo) fail("Completed compensation has no recorded undo");
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  const request: LayerCommitRequest = {
    layer: step.target.layer,
    expectedRevision: receipt.previousRevision,
    operationId,
    mutation:
      undo.action === "set"
        ? { action: "set", key, value: undo.value }
        : { action: "remove", key },
  };
  if (
    receipt.operationId !== operationId ||
    receipt.mutationDigest !== computeProviderMutationDigest(request)
  )
    fail("Compensation receipt does not bind the recorded reverse operation");
  timelines
    .get(identity(step.target.providerId, step.preRevision))
    ?.receipts.push(receipt);
}

function identity(providerId: string, revision: ProviderRevision): string {
  return JSON.stringify([providerId, revision.layer]);
}

function addBaseline(
  timelines: Map<string, Timeline>,
  providerId: string,
  revision: ProviderRevision,
  exact = false,
): Timeline {
  const key = identity(providerId, revision);
  const existing = timelines.get(key);
  if (existing) {
    if (
      !sameIdentity(existing.baseline, revision) ||
      (exact && !deepEqual(existing.baseline, revision))
    )
      fail("Contradictory recovery source revision");
    return existing;
  }
  const timeline = { providerId, baseline: revision, receipts: [] };
  timelines.set(key, timeline);
  return timeline;
}

function addStep(
  timelines: Map<string, Timeline>,
  journal: InternalRecoveryEnvelope,
  step: InternalRecoveryStep,
): void {
  const timeline = addBaseline(
    timelines,
    step.target.providerId,
    step.preRevision,
  );
  if (step.status !== "complete") return;
  const previous = step.receipt.previousRevision;
  const isControl =
    journal.control?.providerId === step.target.providerId &&
    sameIdentity(journal.control.revision, step.preRevision);
  if (!isControl && !deepEqual(previous, step.preRevision))
    fail("Data receipt expected revision does not match recorded pre-revision");
  if (isControl) {
    const intent = journal.control?.receipts.find(
      (receipt) => receipt.operationId === step.intentOperationId,
    );
    if (
      !intent ||
      !deepEqual(intent.revision, previous) ||
      !deepEqual(intent.previousRevision, step.preRevision)
    )
      fail(
        "Control-provider data receipt must chain through its recorded intent",
      );
  }
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  const mutation =
    step.mutation.action === "set"
      ? { action: "set" as const, key, value: step.mutation.value }
      : { action: "remove" as const, key };
  const request: LayerCommitRequest = {
    layer: step.target.layer,
    expectedRevision: previous,
    operationId: step.operationId,
    mutation,
  };
  if (
    step.receipt.operationId !== request.operationId ||
    step.receipt.mutationDigest !== computeProviderMutationDigest(request)
  )
    fail("Recovery receipt does not bind the recorded mutation/request");
  timeline.receipts.push(step.receipt);
}

function sameIdentity(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return deepEqual({ ...left, sequence: right.sequence }, right);
}

function validateDeclaredDataOrder(
  steps: readonly InternalRecoveryStep[],
): void {
  const previousData = new Map<string, ProviderRevision>();
  for (const step of steps) {
    if (step.status !== "complete") continue;
    const key = identity(step.target.providerId, step.preRevision);
    const previous = previousData.get(key);
    if (
      previous &&
      BigInt(step.receipt.previousRevision.sequence) < BigInt(previous.sequence)
    ) {
      fail("Recovery data steps contradict declared authority execution order");
    }
    previousData.set(key, step.receipt.revision);
  }
}

function validateCompensationOrder(
  steps: readonly InternalRecoveryStep[],
): void {
  let incomplete = false;
  for (const step of [...steps].reverse()) {
    if (step.status !== "complete") continue;
    if (step.compensation?.status === "complete") {
      if (incomplete)
        fail("Compensation receipts contradict reverse execution order");
      continue;
    }
    incomplete = true;
  }
}

function validateTimeline(timeline: Timeline): ProviderRevision {
  // Data order is checked before sorting; this merge only places bookkeeping between data receipts.
  const receipts = [...timeline.receipts].sort((a, b) =>
    BigInt(a.previousRevision.sequence) < BigInt(b.previousRevision.sequence)
      ? -1
      : 1,
  );
  const operations = new Set<string>();
  let current = timeline.baseline;
  for (const receipt of receipts) {
    if (
      operations.has(receipt.operationId) ||
      !deepEqual(receipt.previousRevision, current) ||
      !sameIdentity(current, receipt.revision) ||
      BigInt(receipt.revision.sequence) !== BigInt(current.sequence) + 1n
    )
      fail("Recovery receipts do not form a contiguous authority lineage");
    operations.add(receipt.operationId);
    current = receipt.revision;
  }
  return current;
}

function validateCursor(
  cursor: readonly { providerId: string; revision: ProviderRevision }[],
  tips: ReadonlyMap<string, ProviderRevision>,
): void {
  const seen = new Set<string>();
  for (const entry of cursor) {
    const key = identity(entry.providerId, entry.revision);
    if (seen.has(key) || !deepEqual(tips.get(key), entry.revision))
      fail("Recovery cursor does not match recorded source/receipt lineage");
    seen.add(key);
  }
  if (seen.size !== tips.size)
    fail("Recovery cursor omits a recorded authority");
}

function validateEnvironments(timelines: ReadonlyMap<string, Timeline>): void {
  const environments = new Set(
    [...timelines.values()].map((timeline) => timeline.baseline.environment),
  );
  const physical = new Set<string>();
  const stores = new Map<string, string>();
  for (const timeline of timelines.values()) {
    const { storeId, layer, environment } = timeline.baseline;
    const key = JSON.stringify([storeId, layer, environment]);
    if (
      physical.has(key) ||
      (stores.has(timeline.providerId) &&
        stores.get(timeline.providerId) !== storeId)
    )
      fail("Contradictory recovery provider identity");
    physical.add(key);
    stores.set(timeline.providerId, storeId);
  }
  if (environments.size > 1) fail("Recovery authorities cross environments");
}

function fail(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}
