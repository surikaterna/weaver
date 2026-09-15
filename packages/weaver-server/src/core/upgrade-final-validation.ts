import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
} from "@weaver-conf/config-types";
import {
  controlProjection,
  runMaintenanceOperation,
} from "./config-service-internal";
import { buildValidatedFinalContexts } from "./final-context-evidence";
import { loadAllInventoryLayers } from "./upgrade-execution-support";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

export function validateFinalContexts(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
) {
  return runMaintenanceOperation(runtime.configService, async (host) => {
    const current = controlProjection(runtime.configService).prepared()
      .configuration;
    if (current.scopeInventory.revision !== plan.source.inventoryRevision)
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Final validation inventory differs from the bound upgrade plan",
      );
    const layers = await loadAllInventoryLayers(host, plan, journal);
    const prepared = host.pipeline.contracts.prepare({
      ...current,
      catalog: plan.target.registrations
        ? { registrations: plan.target.registrations }
        : current.catalog,
    });
    const validated = await host.pipeline.validate(
      layers,
      prepared,
      plan.contexts,
    );
    return buildValidatedFinalContexts(
      plan,
      validated,
      layers.evidence,
      journal.runId,
      layers,
    );
  });
}

export async function recheckFinalAuthorities(
  runtime: UpgradeRuntimeHost,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): Promise<void> {
  await runMaintenanceOperation(runtime.configService, async (host) => {
    await loadAllInventoryLayers(host, plan, journal);
  });
}
