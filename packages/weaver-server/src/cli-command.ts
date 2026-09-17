import {
  type BootstrapSeed,
  createWeaverError,
} from "@weaver-conf/config-types";
import { initializeWeaver } from "./bootstrap/initialize";
import { inspectWeaver } from "./bootstrap/runtime-open";
import { readBootstrapSeed, readPrivateJson } from "./bootstrap/seed-file";
import {
  authenticateBootstrapAdministrator,
  type BootstrapCredentials,
} from "./bootstrap/seed-trust";
import { runUpgradeCommand } from "./cli-upgrade";
import { startWeaverServer } from "./server";
import { bootstrapCredentialsFromEnvironment } from "./server-env";
import { openWeaverRuntime } from "./server-runtime";

export async function runWeaverCommand(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  output: (text: string) => void = console.log,
) {
  const [command, seedPath, inputPath, ...extra] = argv;
  if (
    !command ||
    !seedPath ||
    extra.length ||
    ![
      "initialize",
      "validate",
      "inspect",
      "start",
      "upgrade-plan",
      "upgrade-apply",
      "upgrade-recover",
      "upgrade-status",
    ].includes(command) ||
    (![
      "initialize",
      "upgrade-plan",
      "upgrade-apply",
      "upgrade-recover",
    ].includes(command) &&
      inputPath)
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Usage: weaver-server initialize|upgrade-plan|upgrade-apply|upgrade-recover <seed.json> <input.json> | upgrade-status|validate|inspect|start <seed.json>",
    );
  const seed = await readBootstrapSeed(seedPath);
  const credentials = bootstrapCredentialsFromEnvironment(environment);
  if (command === "initialize") {
    await initializeCommand(seed, inputPath, environment, credentials, output);
    return undefined;
  }
  if (command === "inspect") {
    output(JSON.stringify(await inspectWeaver(seed, { credentials })));
    return undefined;
  }
  if (command === "start") {
    const server = await startWeaverServer({ seed, credentials });
    output(JSON.stringify({ state: server.runtime.state, port: server.port }));
    return server;
  }
  const runtime = await openWeaverRuntime(seed, { credentials });
  try {
    if (command.startsWith("upgrade-"))
      await runUpgradeCommand(
        command,
        inputPath,
        seed,
        environment,
        credentials,
        runtime,
        output,
      );
    else output(JSON.stringify(runtime.status));
  } finally {
    await runtime.close();
  }
  return undefined;
}
async function initializeCommand(
  seed: BootstrapSeed,
  inputPath: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  credentials: BootstrapCredentials,
  output: (text: string) => void,
): Promise<void> {
  if (!inputPath)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "initialize requires an input file",
    );
  const admin = await authenticateBootstrapAdministrator(
    seed,
    environment.WEAVER_ADMIN_CREDENTIAL ?? "",
    credentials,
  );
  await initializeWeaver(
    seed,
    await readPrivateJson(inputPath, 4_194_304),
    admin,
    { credentials },
  );
  output(
    JSON.stringify({ state: "initialized", environment: seed.environment }),
  );
}
