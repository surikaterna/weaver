import { controlProjection } from "./config-service-internal";
import type { UpgradeRuntimeHost } from "./upgrade-runtime-host";

export function isProjectedTerminal(
  runtime: UpgradeRuntimeHost,
  runId: string,
): boolean {
  const journal = controlProjection(runtime.configService).prepared()
    .configuration.upgrades.journal[runId];
  return (
    !!journal &&
    ["completed", "compensated", "restart-required"].includes(journal.phase)
  );
}
