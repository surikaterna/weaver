import {
  createWeaverError,
  type InternalUpgradePlan,
  type InternalUpgradePlanRequest,
} from "@weaver-conf/config-types";
import { samePlan } from "./upgrade-execution-support";
import {
  type InstalledUpgradeSelection,
  prepareInstalledUpgradePlan,
} from "./upgrade-plan-selection";
import { planRuntimeUpgrade } from "./upgrade-planner";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

export interface PreparedUpgradeExecution {
  readonly plan: InternalUpgradePlan;
  readonly installed?: InstalledUpgradeSelection;
}

export async function prepareUpgradeExecution(
  runtime: UpgradeRuntimeHost,
  request: InternalUpgradePlanRequest,
): Promise<PreparedUpgradeExecution> {
  const installed = await prepareInstalledUpgradePlan(runtime, request);
  if (installed) return { plan: installed.plan, installed };
  const planned = await planRuntimeUpgrade(runtime.configService, request);
  if (planned.result.status !== "ready")
    throw createWeaverError("REVISION_CONFLICT", "Upgrade plan is stale");
  await runtime.enterMaintenance();
  const recomputed = await planRuntimeUpgrade(runtime.configService, request);
  if (
    recomputed.result.status !== "ready" ||
    !samePlan(recomputed.result.plan, planned.result.plan)
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Upgrade authority changed before persistence",
    );
  return { plan: planned.result.plan };
}
