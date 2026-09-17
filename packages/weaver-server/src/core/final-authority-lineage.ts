import {
  deepEqual,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradeFinalLayer,
  type InternalUpgradePlan,
  internalConfigurationSchema,
  internalUpgradeLayerDigest,
  type LayerEnvelope,
  type ProviderRevision,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";

interface ExpectedLayer {
  readonly binding: InternalUpgradeFinalLayer;
  tip: ProviderRevision;
  currentControl?: {
    readonly plan: InternalUpgradePlan;
    readonly journal: InternalRecoveryEnvelope;
  };
}
type LayerCommitReceipt = NonNullable<LayerEnvelope["lastCommit"]>;

export function validateFinalAuthorityLineage(
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): ReadonlyMap<string, ExpectedLayer> {
  if (journal.planId !== plan.id)
    fail("Final authority journal references another plan");
  const layers = sourceLayers(plan);
  validateJournalSources(plan, journal);
  validateControlReceipts(journal, layers);
  validateJournalSteps(plan, journal, layers);
  validateCursor(journal, layers);
  const control = journal.control;
  if (control) {
    const layer = layers.get(
      finalLayerKey(control.providerId, control.revision.layer),
    );
    if (layer) layer.currentControl = { plan, journal };
  }
  return layers;
}

function validateControlReceipts(
  journal: InternalRecoveryEnvelope,
  layers: Map<string, ExpectedLayer>,
): void {
  const control = journal.control;
  if (!control) return;
  const layer = layers.get(
    finalLayerKey(control.providerId, control.revision.layer),
  );
  if (!layer || !deepEqual(layer.tip, control.revision))
    fail("Control lineage baseline differs from the plan source");
  const operations = new Set<string>();
  let tip = control.revision;
  for (const receipt of control.receipts) {
    if (
      operations.has(receipt.operationId) ||
      !deepEqual(receipt.previousRevision, tip) ||
      !sameAuthority(tip, receipt.revision) ||
      BigInt(receipt.revision.sequence) !== BigInt(tip.sequence) + 1n
    )
      fail("Recorded control receipts do not form an exact contiguous lineage");
    operations.add(receipt.operationId);
    tip = receipt.revision;
  }
  if (operations.has(control.operationId))
    fail("Current control operation duplicates recorded lineage");
  layer.tip = tip;
}

function validateJournalSources(
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): void {
  const expected = new Map(
    plan.source.providerRevisions.flatMap((provider) =>
      provider.revisions.map(
        (revision) =>
          [
            finalLayerKey(provider.providerId, revision.layer),
            revision,
          ] as const,
      ),
    ),
  );
  const seen = new Set<string>();
  for (const source of journal.sourceRevisions ?? []) {
    const key = finalLayerKey(source.providerId, source.revision.layer);
    if (seen.has(key) || !deepEqual(expected.get(key), source.revision))
      fail("Journal source revisions differ from the plan baseline");
    seen.add(key);
  }
  if (seen.size !== expected.size)
    fail("Journal source revisions omit a layer");
}

export function assertFinalLayerEvidence(
  expected: ExpectedLayer,
  providerId: string,
  namespace: string,
  envelope: LayerEnvelope,
  control: boolean,
): void {
  const binding = expected.binding;
  if (providerId !== binding.providerId || namespace !== binding.namespace)
    fail("Final layer provider identity differs from its plan");
  if (control) {
    validateCurrentControlWrite(expected, envelope);
    validateStoredControl(expected, envelope);
  } else if (!deepEqual(expected.tip, revisionOf(envelope))) {
    fail("Final layer revision differs from its recorded lineage");
  }
  if (
    internalUpgradeLayerDigest(envelope.entries, binding.contentDomain) !==
    binding.finalDigest
  )
    fail("Final layer content differs from its planned digest");
}

function validateCurrentControlWrite(
  expected: ExpectedLayer,
  envelope: LayerEnvelope,
): void {
  const current = expected.currentControl;
  const receipt = envelope.lastCommit;
  if (!current || !receipt)
    fail("Current durable control journal receipt is missing");
  const operationId = current.journal.control?.operationId;
  const digest = operationId
    ? computeProviderMutationDigest({
        layer: expected.tip.layer,
        expectedRevision: expected.tip,
        operationId,
        mutation: {
          action: "set",
          key: `_weaver.upgrades.journal.${current.journal.runId}`,
          value: JSON.parse(canonicalInternalJson(current.journal)),
        },
      })
    : undefined;
  if (
    receipt.operationId !== operationId ||
    receipt.mutationDigest !== digest ||
    !deepEqual(receipt.previousRevision, expected.tip) ||
    !sameAuthority(expected.tip, receipt.revision) ||
    BigInt(receipt.revision.sequence) !== BigInt(expected.tip.sequence) + 1n ||
    !deepEqual(revisionOf(envelope), receipt.revision)
  )
    fail("Current durable control journal write is not exact");
}

function validateStoredControl(
  expected: ExpectedLayer,
  envelope: LayerEnvelope,
): void {
  const current = expected.currentControl;
  const configuration = internalConfigurationSchema.safeParse(
    envelope.entries._weaver,
  );
  if (
    !current ||
    !configuration.success ||
    !deepEqual(
      configuration.data.upgrades.plans[current.plan.id],
      current.plan,
    ) ||
    !deepEqual(
      configuration.data.upgrades.journal[current.journal.runId],
      current.journal,
    )
  )
    fail("Stored control plan or journal differs from final authority");
}

export function finalLayerKey(providerId: string, layer: string): string {
  return canonicalInternalJson([providerId, layer]);
}

function sourceLayers(plan: InternalUpgradePlan): Map<string, ExpectedLayer> {
  const revisions = new Map(
    plan.source.providerRevisions.flatMap((provider) =>
      provider.revisions.map(
        (revision) =>
          [
            finalLayerKey(provider.providerId, revision.layer),
            revision,
          ] as const,
      ),
    ),
  );
  const layers = new Map<string, ExpectedLayer>();
  for (const binding of plan.finalLayers) {
    const key = finalLayerKey(binding.providerId, binding.layer);
    const revision = revisions.get(key);
    if (
      layers.has(key) ||
      !revision ||
      !bindingMatchesRevision(binding, revision)
    )
      fail("Final layer binding does not exactly cover the source inventory");
    layers.set(key, { binding, tip: revision });
  }
  if (layers.size !== revisions.size)
    fail("Final layer bindings omit source inventory authority");
  validateSourceDigests(plan, layers);
  return layers;
}

function validateSourceDigests(
  plan: InternalUpgradePlan,
  layers: ReadonlyMap<string, ExpectedLayer>,
): void {
  const seen = new Set<string>();
  for (const digest of plan.source.dataDigests) {
    const key = finalLayerKey(digest.providerId, digest.layer);
    const layer = layers.get(key);
    if (
      seen.has(key) ||
      !layer ||
      digest.storeId !== layer.binding.storeId ||
      digest.digest !== layer.binding.sourceDigest
    )
      fail("Final layer source digest differs from its plan source");
    seen.add(key);
  }
  if (seen.size !== layers.size) fail("Source data digests omit a final layer");
}

function validateJournalSteps(
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  layers: Map<string, ExpectedLayer>,
): void {
  if (journal.steps.length !== plan.steps.length)
    fail("Final authority journal step count differs from its plan");
  for (const [index, recorded] of journal.steps.entries()) {
    const planned = plan.steps[index];
    if (
      !planned ||
      recorded.status !== "complete" ||
      !sameStep(planned, recorded)
    )
      fail("Final authority journal steps are missing, reordered, or foreign");
    const layer = layers.get(
      finalLayerKey(planned.target.providerId, planned.target.layer),
    );
    if (!layer || !deepEqual(recorded.preRevision, layer.tip))
      fail("Final authority step skips its prior recorded revision");
    validateReceipt(recorded.receipt, recorded.operationId, planned, layer.tip);
    layer.tip = recorded.receipt.revision;
  }
}

function validateReceipt(
  receipt: LayerCommitReceipt,
  operationId: string,
  step: InternalUpgradePlan["steps"][number],
  previous: ProviderRevision,
): void {
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  const mutation =
    step.mutation.action === "set"
      ? { action: "set" as const, key, value: step.mutation.value }
      : { action: "remove" as const, key };
  const digest = computeProviderMutationDigest({
    layer: step.target.layer,
    expectedRevision: previous,
    operationId,
    mutation,
  });
  if (
    receipt.operationId !== operationId ||
    receipt.mutationDigest !== digest ||
    !deepEqual(receipt.previousRevision, previous) ||
    !sameAuthority(previous, receipt.revision) ||
    BigInt(receipt.revision.sequence) !== BigInt(previous.sequence) + 1n
  )
    fail("Final authority receipt does not exactly continue its lineage");
}

function validateCursor(
  journal: InternalRecoveryEnvelope,
  layers: ReadonlyMap<string, ExpectedLayer>,
): void {
  if (!("cursor" in journal) || !journal.cursor)
    fail("Final authority journal cursor is missing");
  const seen = new Set<string>();
  for (const entry of journal.cursor) {
    const key = finalLayerKey(entry.providerId, entry.revision.layer);
    if (seen.has(key) || !deepEqual(layers.get(key)?.tip, entry.revision))
      fail("Final authority cursor is duplicate, foreign, or stale");
    seen.add(key);
  }
  if (seen.size !== layers.size) fail("Final authority cursor omits a layer");
}

function sameStep(
  planned: InternalUpgradePlan["steps"][number],
  recorded: InternalRecoveryEnvelope["steps"][number],
): boolean {
  return (
    planned.id === recorded.id &&
    deepEqual(planned.target, recorded.target) &&
    planned.preDigest === recorded.preDigest &&
    planned.postDigest === recorded.postDigest &&
    deepEqual(planned.mutation, recorded.mutation) &&
    deepEqual(planned.undo, recorded.undo)
  );
}

function bindingMatchesRevision(
  binding: InternalUpgradeFinalLayer,
  revision: ProviderRevision,
): boolean {
  return (
    binding.storeId === revision.storeId &&
    binding.environment === revision.environment &&
    binding.layer === revision.layer
  );
}

function revisionOf(envelope: LayerEnvelope): ProviderRevision {
  const { storeId, environment, layer, epoch, sequence } = envelope;
  return { storeId, environment, layer, epoch, sequence };
}

function sameAuthority(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return deepEqual({ ...left, sequence: right.sequence }, right);
}

function fail(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}
