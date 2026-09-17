import {
  createWeaverError,
  internalUpgradePlanRequestSchema,
  type MaintenanceStatus,
  publicMaintenanceFailure,
  type UpgradeExecutionResult,
  upgradeApplyRequestSchema,
  upgradeRecoveryRequestSchema,
} from "@weaver-conf/config-types";
import { readPrivateJson } from "./bootstrap/seed-file";
import {
  authenticateBootstrapAdministrator,
  type BootstrapCredentials,
} from "./bootstrap/seed-trust";
import type { WeaverRuntime } from "./server-runtime";

export async function runUpgradeCommand(
  command: string,
  inputPath: string | undefined,
  seed: import("@weaver-conf/config-types").BootstrapSeed,
  environment: Readonly<Record<string, string | undefined>>,
  credentials: BootstrapCredentials,
  runtime: WeaverRuntime,
  output: (text: string) => void,
): Promise<void> {
  await authenticateBootstrapAdministrator(
    seed,
    environment.WEAVER_ADMIN_CREDENTIAL ?? "",
    credentials,
  );
  if (command === "upgrade-status") {
    output(publicUpgradeOutput(runtime.maintenanceStatus()));
    return;
  }
  if (!inputPath)
    throw createWeaverError(
      "VALIDATION_ERROR",
      `${command} requires an input file`,
    );
  const input = await readPrivateJson(inputPath, 4_194_304);
  if (command === "upgrade-plan") {
    output(
      JSON.stringify(
        await runtime.planUpgrade(
          internalUpgradePlanRequestSchema.parse(input),
        ),
      ),
    );
    return;
  }
  if (command === "upgrade-apply") {
    const result = await runtime.applyUpgrade(
      upgradeApplyRequestSchema.parse(input),
    );
    output(publicUpgradeOutput(result));
    if (result.status === "blocked") process.exitCode = 2;
    return;
  }
  const result = await runtime.recoverUpgrade(
    upgradeRecoveryRequestSchema.parse(input),
  );
  output(publicUpgradeOutput(result));
  if (result.status === "blocked") process.exitCode = 2;
}

export function publicUpgradeOutput(
  value: MaintenanceStatus | UpgradeExecutionResult,
): string {
  return JSON.stringify(value);
}

export function publicUpgradeCliError() {
  return { error: publicMaintenanceFailure("internal") };
}
