import {
  canonicalInternalJson,
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
} from "@weaver-conf/config-types";
import { runMaintenanceOperation } from "./config-service-internal";
import { reconstructValidatedFinalContexts } from "./final-context-evidence";
import type { TerminalControlSnapshot } from "./terminal-control-authority";
import { loadAllInventoryLayers } from "./upgrade-execution-support";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

export function reconstructFinalContexts(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  control?: TerminalControlSnapshot,
) {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const binding =
      journal.activation?.status === "pending"
        ? undefined
        : journal.activation?.finalContexts;
    if (!binding)
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Validated final context evidence is unavailable",
      );
    const layers = await loadAllInventoryLayers(
      host,
      plan,
      journal,
      control?.envelope,
    );
    const prepared = host.pipeline.contracts.prepare({
      ...host.pipeline.contracts.prepared().configuration,
      catalog: plan.target.registrations
        ? { registrations: plan.target.registrations }
        : host.pipeline.contracts.prepared().configuration.catalog,
    });
    const candidate = await host.pipeline.validate(
      layers,
      prepared,
      plan.contexts,
    );
    const snapshot = reconstructValidatedFinalContexts(
      plan,
      candidate,
      binding.layers,
      journal.runId,
      binding.nonce,
      layers,
    );
    if (
      canonicalInternalJson(snapshot.binding) !== canonicalInternalJson(binding)
    )
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Reconstructed final contexts differ from activation evidence",
      );
    return snapshot;
  });
}
