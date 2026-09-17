#!/usr/bin/env node
import { WeaverErrorInstance } from "@weaver-conf/config-types";
import { runWeaverCommand } from "./cli-command";
import { publicUpgradeCliError } from "./cli-upgrade";

async function main(): Promise<void> {
  const server = await runWeaverCommand(process.argv.slice(2), process.env);
  if (!server) return;
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void server.close().catch(reportFailure);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
function reportFailure(error: unknown): void {
  const upgradeCommand = process.argv[2]?.startsWith("upgrade-") ?? false;
  console.error(JSON.stringify(publicCliError(error, upgradeCommand)));
  process.exitCode = 1;
}

export function publicCliError(error: unknown, upgradeCommand: boolean) {
  if (upgradeCommand) return publicUpgradeCliError();
  return {
    error: {
      code:
        error instanceof WeaverErrorInstance ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Command failed",
    },
  };
}
void main().catch(reportFailure);
