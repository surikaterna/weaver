import { deepEqual } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type InternalConfiguration,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  internalUpgradeLayerDigest,
  providerInventorySchema,
} from "@weaver-conf/config-types";
import {
  activationIntentMatchesPlan,
  completedPoststateMatches,
} from "./activation-recovery";
import { assertSupportedSourceBuiltinCatalog } from "./builtin-catalog";
import {
  applicationAdmission,
  runMaintenanceOperation,
} from "./config-service-internal";
import {
  type InternalUpgradeExecutionResult,
  internalUpgradeResult,
} from "./public-upgrade-status";
import { transitionDigest } from "./schema-transition";
import {
  assertCachedTerminalState,
  assertTerminalAuthorityUnchanged,
  readTerminalControlSnapshot,
  type TerminalControlSnapshot,
} from "./terminal-control-authority";
import type { UpgradeApplicationAdmission } from "./upgrade-application-admission";
import { reconstructFinalContexts } from "./upgrade-context-recovery";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

type TerminalJournal = Extract<
  InternalRecoveryEnvelope,
  { phase: "completed" | "compensated" | "restart-required" }
>;
type TerminalOutcome = "completed" | "restart-required";

interface TerminalActivation {
  readonly status: "complete";
  readonly terminal: TerminalOutcome;
}

export async function recoverTerminalUpgrade(
  runtime: UpgradeRuntimeHost,
  journal: InternalRecoveryEnvelope,
  admission: UpgradeApplicationAdmission,
): Promise<InternalUpgradeExecutionResult | undefined> {
  if (!isTerminal(journal)) return undefined;
  try {
    const authority = await readTerminalControlSnapshot(runtime, journal);
    const { state, plan } = authority;
    assertTerminalBindings(state, plan, journal);
    if (journal.phase === "restart-required") {
      assertRestartTerminal(state, plan, journal);
      await requireRestart(runtime);
      return terminalResult(journal, "restart-required");
    }
    if (journal.phase === "completed") {
      assertCompletedApplication(state, plan, journal);
      await restoreCompletedApplication(runtime, authority, journal, admission);
      return terminalResult(journal, "completed");
    }
    if (await isSafeCompensation(runtime, state, plan, journal)) {
      await assertTerminalAuthorityUnchanged(runtime, authority);
      if (!applicationAdmission(runtime.configService))
        await refreshCompensatedSource(runtime);
      await restoreApplication(runtime, authority, admission);
      return terminalResult(journal, "compensated");
    }
    await requireRestart(runtime);
    return terminalResult(journal, "restart-required");
  } catch (error) {
    await requireRestart(runtime);
    throw error;
  }
}

function isTerminal(
  journal: InternalRecoveryEnvelope,
): journal is TerminalJournal {
  return ["completed", "compensated", "restart-required"].includes(
    journal.phase,
  );
}

function assertTerminalBindings(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: TerminalJournal,
): void {
  assertSupportedSourceBuiltinCatalog(journal.source);
  const expectedTarget = plan.target.builtinCatalog ?? journal.source;
  assertSupportedSourceBuiltinCatalog(journal.target);
  const expectedTerminal = hasRestartTarget(plan)
    ? "restart-required"
    : "completed";
  const activation = journal.activation;
  if (
    journal.control === undefined ||
    journal.infrastructureGeneration !== plan.source.infrastructureGeneration ||
    !deepEqual(journal.target, expectedTarget) ||
    journal.control.revision.storeId !== state.format.storeId ||
    journal.control.revision.environment !== state.format.environment ||
    (activation !== undefined &&
      activation.status !== "pending" &&
      !hasTerminalOutcome(activation, expectedTerminal) &&
      !(
        journal.phase === "compensated" &&
        activationIntentMatchesPlan(plan, journal)
      ))
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Terminal recovery bindings contradict the recorded plan",
    );
}

function assertCompletedApplication(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: Extract<TerminalJournal, { phase: "completed" }>,
): void {
  if (
    hasRestartTarget(plan) ||
    !hasTerminalOutcome(journal.activation, "completed") ||
    !matchesTargetState(state, plan, journal) ||
    !completedPoststateMatches(state, plan, journal)
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Completed recovery does not bind an active application target",
    );
}

function assertRestartTerminal(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: Extract<TerminalJournal, { phase: "restart-required" }>,
): void {
  if (
    !hasRestartTarget(plan) ||
    !hasTerminalOutcome(journal.activation, "restart-required") ||
    !matchesTargetState(state, plan, journal) ||
    !completedPoststateMatches(state, plan, journal)
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Restart recovery does not bind an activated restart target",
    );
}

async function isSafeCompensation(
  runtime: UpgradeRuntimeHost,
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: Extract<TerminalJournal, { phase: "compensated" }>,
): Promise<boolean> {
  if (
    hasRestartTarget(plan) ||
    journal.activation?.status === "complete" ||
    !matchesSourceState(state, plan, journal)
  )
    return false;
  if (
    journal.steps.some(
      (step) =>
        step.status === "intent" ||
        (step.status === "complete" &&
          step.compensation?.status !== "complete"),
    )
  )
    return false;
  return hasSourceApplicationData(runtime, plan);
}

function matchesTargetState(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: TerminalJournal,
): boolean {
  return (
    transitionDigest(state.catalog) === plan.target.catalogDigest &&
    (!plan.target.registrations ||
      deepEqual(state.catalog.registrations, plan.target.registrations)) &&
    deepEqual(state.format.builtinCatalog, journal.target) &&
    state.infrastructure.activeGeneration ===
      (plan.target.infrastructureGeneration ??
        plan.source.infrastructureGeneration) &&
    deepEqual(state.upgrades.journal[journal.runId], journal)
  );
}

function matchesSourceState(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: TerminalJournal,
): boolean {
  return (
    transitionDigest(state.catalog) === plan.source.catalogDigest &&
    state.scopeInventory.revision === plan.source.inventoryRevision &&
    state.infrastructure.activeGeneration ===
      plan.source.infrastructureGeneration &&
    deepEqual(state.format.builtinCatalog, journal.source) &&
    deepEqual(state.upgrades.journal[journal.runId], journal)
  );
}

async function hasSourceApplicationData(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
): Promise<boolean> {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const control = host.pipeline.controlProvider;
    for (const expected of plan.source.dataDigests) {
      if (
        expected.providerId === control.id &&
        expected.layer === control.layer
      )
        continue;
      const provider = host.providers.find(
        (item) => item.id === expected.providerId,
      );
      const envelope = await provider?.authority?.readLayer(expected.layer);
      if (
        !envelope ||
        internalUpgradeLayerDigest(envelope.entries, expected.contentDomain) !==
          expected.digest
      )
        return false;
    }
    return true;
  });
}

function hasRestartTarget(plan: InternalUpgradePlan): boolean {
  return !!(plan.target.builtinCatalog || plan.target.infrastructureGeneration);
}

function hasTerminalOutcome(
  activation: unknown,
  expected: TerminalOutcome,
): activation is TerminalActivation {
  return (
    typeof activation === "object" &&
    activation !== null &&
    "status" in activation &&
    activation.status === "complete" &&
    "terminal" in activation &&
    activation.terminal === expected
  );
}

async function restoreApplication(
  runtime: UpgradeRuntimeHost,
  authority: TerminalControlSnapshot,
  admission: UpgradeApplicationAdmission,
): Promise<void> {
  await validateCurrentApplication(runtime, authority);
  if (applicationAdmission(runtime.configService)) {
    await assertTerminalAuthorityUnchanged(runtime, authority);
    return;
  }
  await admission.terminal(authority);
}

async function restoreCompletedApplication(
  runtime: UpgradeRuntimeHost,
  authority: TerminalControlSnapshot,
  journal: Extract<TerminalJournal, { phase: "completed" }>,
  admission: UpgradeApplicationAdmission,
): Promise<void> {
  if (applicationAdmission(runtime.configService)) {
    await validateCurrentApplication(runtime, authority);
    await assertTerminalAuthorityUnchanged(runtime, authority);
    return;
  }
  if (await hasAcceptedLaterApplication(runtime, authority.plan)) {
    await validateCurrentApplication(runtime, authority);
    await admission.terminal(authority);
    return;
  }
  const contexts = await reconstructFinalContexts(
    runtime,
    authority.plan,
    journal,
    authority,
  );
  await admission.terminal(authority, contexts);
}

async function hasAcceptedLaterApplication(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
): Promise<boolean> {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    let changed = false;
    for (const provider of host.providers) {
      if (!provider.authority) return false;
      const inventory = providerInventorySchema.parse(
        await provider.authority.inventory(),
      );
      if (!host.authority.matches(provider, inventory)) return false;
      for (const revision of inventory.revisions) {
        const binding = plan.finalLayers.find(
          (item) =>
            item.providerId === provider.id && item.layer === revision.layer,
        );
        if (!binding) return false;
        const envelope = await provider.authority.readLayer(revision.layer);
        const cached =
          revision.layer === provider.layer
            ? host.layerData.get(provider.id)
            : host.dynamicScopeEntries.get(revision.layer);
        if (!cached || !deepEqual(cached, envelope.entries)) return false;
        if (
          internalUpgradeLayerDigest(
            envelope.entries,
            binding.contentDomain,
          ) !== binding.finalDigest
        )
          changed = true;
      }
    }
    return changed;
  });
}

async function validateCurrentApplication(
  runtime: UpgradeRuntimeHost,
  authority: TerminalControlSnapshot,
): Promise<void> {
  await runMaintenanceOperation(runtime.configService, async (host) => {
    const cached = host.layerData.get(
      host.pipeline.controlProvider.id,
    )?._weaver;
    assertCachedTerminalState(cached, authority);
    await host.pipeline.validate(
      { base: host.layerData, scoped: host.dynamicScopeEntries },
      host.pipeline.contracts.prepare(authority.state),
    );
  });
}

async function refreshCompensatedSource(
  runtime: UpgradeRuntimeHost,
): Promise<void> {
  await runMaintenanceOperation(runtime.configService, (host) =>
    host.reload([...host.providers], false),
  );
}

async function requireRestart(runtime: UpgradeRuntimeHost): Promise<void> {
  if (applicationAdmission(runtime.configService))
    await runtime.enterMaintenance();
  runtime.requireRestart();
}

function terminalResult(
  journal: TerminalJournal,
  status: "completed" | "compensated" | "restart-required",
): InternalUpgradeExecutionResult {
  const internal = internalUpgradeResult(journal);
  return { ...internal, status };
}
