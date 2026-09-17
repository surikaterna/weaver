import type {
  InternalRecoveryEnvelope,
  InternalUpgradePlan,
} from "@weaver-conf/config-types";
import type { createControlService } from "./control-service";
import type { InternalUpgradeExecutionResult } from "./public-upgrade-status";
import { compensateUpgrade } from "./upgrade-compensation";
import { blockRecovery, recoveryResult } from "./upgrade-recovery-result";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

type Control = Awaited<ReturnType<typeof createControlService>>;

export async function recoverCompensation(
  runtime: UpgradeRuntimeHost,
  control: Control,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  runId: string,
): Promise<InternalUpgradeExecutionResult> {
  try {
    return recoveryResult(
      await compensateUpgrade(runtime, control, plan, journal),
    );
  } catch (error) {
    const durable = await control.readRecovery(runId);
    return blockRecovery(
      control,
      durable,
      error instanceof Error && error.message.includes("acknowledged")
        ? "unknown-commit"
        : "operator-required",
      error instanceof Error ? error.message : "Compensation failed",
    );
  }
}
