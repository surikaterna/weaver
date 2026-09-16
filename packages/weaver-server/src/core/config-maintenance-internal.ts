import { deepEqual, deepGet } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type InternalConfiguration,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalConfigurationSchema,
} from "@weaver-conf/config-types";
import { activationCompletionOperationId } from "./activation-completion-operation";
import { readBuiltinRecoveryEnvelope } from "./builtin-catalog";
import {
  clearInternalPermission,
  hostForControl,
  setInternalPermission,
} from "./config-service-internal";
import type { WeaverConfigService } from "./config-service-types";
import { prepareSchemaTransition } from "./schema-transition";

export function repairControlStep(
  service: WeaverConfigService,
  runId: string,
  stepId: string,
  owner: string,
  expectedRevision: string,
) {
  const host = hostForControl(service);
  return host.coordinator.runControl(async () => {
    host.assertReady(true);
    const transition = await prepareSchemaTransition(
      host,
      runId,
      stepId,
      owner,
      expectedRevision,
    );
    const context = { expectedRevision };
    setInternalPermission(context, {
      family: "maintenance",
      key: transition.key,
      transition,
    });
    try {
      return await host.mutations.set(
        transition.layer,
        transition.key,
        transition.value,
        context,
      );
    } finally {
      clearInternalPermission(context);
    }
  });
}

export function controlRecovery(service: WeaverConfigService, runId: string) {
  const host = hostForControl(service);
  return host.coordinator.runControl(async () => {
    host.assertReady(true);
    if (!/^[a-f0-9-]{36}$/.test(runId))
      throw createWeaverError("VALIDATION_ERROR", "Invalid recovery identity");
    return readBuiltinRecoveryEnvelope(
      deepGet(
        host.layerData.get(host.pipeline.controlProvider.id) ?? {},
        `_weaver.upgrades.journal.${runId}`,
      ),
    );
  });
}

export function activateUpgradeControl(
  service: WeaverConfigService,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  expectedRevision: string,
) {
  const host = hostForControl(service);
  return host.coordinator.runControl(async () => {
    host.assertReady(true);
    if (host.applicationActive)
      throw createWeaverError(
        "FORBIDDEN",
        "Upgrade activation requires maintenance",
      );
    const projected = activationCandidate(
      host.pipeline.contracts.prepared().configuration,
      plan,
      journal,
    );
    const durable = await completeControlState(host, plan, journal);
    const next = activationCandidate(durable, plan, journal);
    const operationId =
      journal.activation?.status === "intent"
        ? journal.activation.operationId
        : undefined;
    if (!operationId)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Activation intent is missing",
      );
    const context = { expectedRevision };
    setInternalPermission(context, {
      family: "maintenance",
      key: "_weaver",
      transition: {
        prepared: host.pipeline.contracts.prepare(projected),
        operationId,
      },
    });
    try {
      const result = await host.mutations.set(
        host.pipeline.controlProvider.layer,
        "_weaver",
        next,
        context,
      );
      if (!result.success) return { result };
      const envelope = await host.pipeline.controlProvider.authority?.readLayer(
        host.pipeline.controlProvider.layer,
      );
      return { result, receipt: envelope?.lastCommit };
    } finally {
      clearInternalPermission(context);
    }
  });
}

export async function recordActivationCompletion(
  service: WeaverConfigService,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  const host = hostForControl(service);
  await host.coordinator.runControl(async () => {
    host.assertReady(true);
    const state = host.pipeline.contracts.prepared().configuration;
    const projected = structuredClone(state);
    projected.upgrades.journal[journal.runId] = journal;
    const durable = await completeControlState(
      host,
      state.upgrades.plans[journal.planId],
      state.upgrades.journal[journal.runId],
    );
    const next = structuredClone(durable);
    next.upgrades.journal[journal.runId] = journal;
    if (journal.activation?.status !== "complete")
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Activation completion receipt is missing",
      );
    const context = { expectedRevision: host.authority.revision() };
    setInternalPermission(context, {
      family: "maintenance",
      key: "_weaver",
      transition: {
        prepared: host.pipeline.contracts.prepare(projected),
        operationId: activationCompletionOperationId(journal.runId),
      },
    });
    try {
      const result = await host.mutations.set(
        host.pipeline.controlProvider.layer,
        "_weaver",
        next,
        context,
      );
      if (!result.success)
        throw createWeaverError(
          "REVISION_CONFLICT",
          result.error?.message ?? "Activation completion write failed",
        );
    } finally {
      clearInternalPermission(context);
    }
  });
}

async function completeControlState(
  host: ReturnType<typeof hostForControl>,
  plan: InternalUpgradePlan | undefined,
  journal: InternalRecoveryEnvelope | undefined,
): Promise<InternalConfiguration> {
  if (!plan || !journal) return failCompleteControl();
  const provider = host.pipeline.controlProvider;
  const envelope = await provider.authority?.readLayer(provider.layer);
  const parsed = internalConfigurationSchema.safeParse(
    envelope?.entries._weaver,
  );
  if (
    !parsed.success ||
    !deepEqual(parsed.data.upgrades.plans[plan.id], plan) ||
    !deepEqual(parsed.data.upgrades.journal[journal.runId], journal)
  )
    return failCompleteControl();
  return parsed.data;
}

function failCompleteControl(): never {
  throw createWeaverError(
    "VALIDATION_ERROR",
    "Complete durable control state differs from selected recovery",
  );
}

function activationCandidate(
  state: import("@weaver-conf/config-types").InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
) {
  const next = structuredClone(state);
  if (plan.target.registrations)
    next.catalog.registrations = structuredClone(plan.target.registrations);
  next.format.builtinCatalog = structuredClone(
    plan.target.builtinCatalog ?? journal.target,
  );
  if (plan.target.infrastructureGeneration)
    next.infrastructure.activeGeneration = plan.target.infrastructureGeneration;
  next.upgrades.journal[journal.runId] = journal;
  return next;
}
