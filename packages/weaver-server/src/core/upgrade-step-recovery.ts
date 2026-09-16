import { deepEqual } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalRecoveryStep,
  type InternalUpgradePlan,
  internalRecoveryEnvelopeSchema,
  type ProviderRevision,
  providerInventorySchema,
} from "@weaver-conf/config-types";
import { runMaintenanceOperation } from "./config-service-internal";
import type { createControlService } from "./control-service";
import {
  assertFinalLayerEvidence,
  finalLayerKey,
  validateFinalAuthorityLineage,
} from "./final-authority-lineage";
import {
  committedReceipt,
  exactPrestate,
  providerFor,
  replaceCursor,
} from "./upgrade-execution-support";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

type Control = Awaited<ReturnType<typeof createControlService>>;

export async function recoverUpgradeStepIntent(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  id: string,
): Promise<InternalRecoveryEnvelope> {
  const index = journal.steps.findIndex((step) => step.id === id);
  const step = plan.steps[index];
  const recorded = journal.steps[index];
  if (!step || recorded?.status !== "intent")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Recovery intent is inconsistent",
    );
  const envelope = await readTarget(runtime, step);
  let receipt = committedReceipt(
    { ...step, id: recorded.operationId },
    envelope,
  );
  if (!receipt && exactPrestate(step, envelope))
    receipt = await executeRecordedIntent(runtime, control, journal, step, id);
  if (!receipt)
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Intent matches neither exact prestate nor committed receipt",
    );
  const next = completeIntentJournal(journal, step, recorded, index, receipt);
  await persist(control, next);
  return next;
}

async function executeRecordedIntent(
  runtime: UpgradeRuntimeHost,
  control: Control,
  journal: InternalRecoveryEnvelope,
  step: InternalUpgradePlan["steps"][number],
  id: string,
) {
  const write = await control.repairStep(journal.runId, id, control.revision);
  if (!write.success)
    throw createWeaverError(
      "REVISION_CONFLICT",
      write.error?.message ?? "Recovery step write failed",
    );
  return committedReceipt(
    {
      ...step,
      id: journal.steps.find((item) => item.id === id)?.operationId ?? "",
    },
    await readTarget(runtime, step),
  );
}

export async function inspectUpgradeStepIntent(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  id: string,
): Promise<
  | { readonly status: "prestate" }
  | { readonly status: "poststate"; readonly journal: InternalRecoveryEnvelope }
> {
  const index = journal.steps.findIndex((step) => step.id === id);
  const step = plan.steps[index];
  const recorded = journal.steps[index];
  if (!step || recorded?.status !== "intent")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Recovery intent is inconsistent",
    );
  const envelope = await readTarget(runtime, step);
  if (exactPrestate(step, envelope)) return { status: "prestate" };
  const receipt = committedReceipt(
    { ...step, id: recorded.operationId },
    envelope,
  );
  if (receipt)
    return {
      status: "poststate",
      journal: completeIntentJournal(journal, step, recorded, index, receipt),
    };
  throw createWeaverError(
    "REVISION_CONFLICT",
    "Intent matches neither exact prestate nor committed receipt",
  );
}

function completeIntentJournal(
  journal: InternalRecoveryEnvelope,
  step: InternalUpgradePlan["steps"][number],
  recorded: Extract<InternalRecoveryStep, { status: "intent" }>,
  index: number,
  receipt: Extract<InternalRecoveryStep, { status: "complete" }>["receipt"],
) {
  const complete = {
    ...recorded,
    status: "complete",
    receipt,
  } satisfies InternalRecoveryStep;
  return internalRecoveryEnvelopeSchema.parse({
    ...journal,
    phase: "applying",
    steps: journal.steps.map((item, position) =>
      position === index ? complete : item,
    ),
    cursor: replaceCursor(journal, step.target.providerId, receipt.revision),
  });
}

export function assertJournalPlanBinding(
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): void {
  const expectedTarget = plan.target.builtinCatalog ?? journal.source;
  const stepsMatch = plan.steps.every((step, index) => {
    const recorded = journal.steps[index];
    return Boolean(
      recorded &&
        recorded.id === step.id &&
        deepEqual(recorded.target, step.target) &&
        sameRevisionIdentity(recorded.preRevision, step.expectedRevision) &&
        BigInt(recorded.preRevision.sequence) >=
          BigInt(step.expectedRevision.sequence) &&
        recorded.preDigest === step.preDigest &&
        recorded.postDigest === step.postDigest &&
        deepEqual(recorded.mutation, step.mutation) &&
        deepEqual(recorded.undo, step.undo),
    );
  });
  if (
    journal.planId !== plan.id ||
    journal.steps.length !== plan.steps.length ||
    !stepsMatch ||
    !deepEqual(journal.sourceRevisions, sourceRevisions(plan)) ||
    !deepEqual(journal.target, expectedTarget) ||
    journal.infrastructureGeneration !== plan.source.infrastructureGeneration
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Recovery journal does not match its bound plan",
    );
}

function sameRevisionIdentity(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return deepEqual({ ...left, sequence: right.sequence }, right);
}

export async function validateRecoveredStepPoststate(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  const lineage = validateFinalAuthorityLineage(plan, journal);
  await runMaintenanceOperation(runtime.configService, async (host) => {
    for (const provider of host.providers) {
      if (provider === host.pipeline.controlProvider || !provider.authority)
        continue;
      const capabilities = provider.authority.capabilities;
      if (!("namespace" in capabilities))
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          "Recovery namespace is missing",
        );
      const inventory = providerInventorySchema.parse(
        await provider.authority.inventory(),
      );
      for (const revision of inventory.revisions) {
        const expected = lineage.get(
          finalLayerKey(provider.id, revision.layer),
        );
        if (!expected)
          throw createWeaverError(
            "VALIDATION_ERROR",
            "Recovery layer is unplanned",
          );
        assertFinalLayerEvidence(
          expected,
          provider.id,
          capabilities.namespace,
          await provider.authority.readLayer(revision.layer),
          false,
        );
      }
    }
  });
}

function sourceRevisions(plan: InternalUpgradePlan) {
  return plan.source.providerRevisions.flatMap((provider) =>
    provider.revisions.map((revision) => ({
      providerId: provider.providerId,
      revision,
    })),
  );
}

function readTarget(
  runtime: UpgradeRuntimeHost,
  step: InternalUpgradePlan["steps"][number],
) {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const provider = providerFor(host, step);
    const envelope = await provider.authority?.readLayer(step.target.layer);
    if (!envelope)
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Provider read is uncertain",
      );
    return envelope;
  });
}

async function persist(
  control: Control,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  const value = await control.replaceJournal(journal, control.revision);
  if (!value.success)
    throw createWeaverError(
      "REVISION_CONFLICT",
      value.error?.message ?? "Recovery journal write failed",
    );
}
