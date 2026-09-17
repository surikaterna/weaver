import { spawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import {
  partitionManifest,
  partitionSuites,
  gateManifests,
  verifyGateManifest,
  verifyPartitionManifest,
} from "./partition-manifest.mjs";

export function parseRunnerArgs(args) {
  if (args.length !== 1) throw new Error("Expected exactly one partition name or verification command");
  const [name] = args;
  if (name === "verify-all") return Object.freeze({ kind: "verify-all" });
  if (name === "verify-default") return Object.freeze({ kind: "verify-gate", gate: "default" });
  if (name === "verify-live") return Object.freeze({ kind: "verify-gate", gate: "live" });
  if (!(name in partitionManifest)) throw new Error(`Unknown test partition: ${name}`);
  return Object.freeze({ kind: "partition", name });
}

function commandFor(name) {
  const files = partitionManifest[name];
  if (partitionSuites[name] === "node") {
    return ["node", [
      "--import", "tsx", "--test", "--test-concurrency=1",
      "--test-reporter=./test/no-skips-node-reporter.mjs", ...files,
    ]];
  }
  return ["corepack", [
    "pnpm", "exec", "vitest", "run", "--maxWorkers=1", "--no-file-parallelism",
    "--reporter=default", "--reporter=./test/no-skips-vitest-reporter.mjs", ...files,
  ]];
}

async function runPartition(name) {
  const [command, args] = commandFor(name);
  const child = spawn(command, args, { shell: false, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  if (result.signal) {
    process.kill(process.pid, result.signal);
    process.exitCode = 128 + (constants.signals[result.signal] ?? 1);
    return;
  }
  process.exitCode = result.code ?? 1;
}

async function main() {
  const selection = parseRunnerArgs(process.argv.slice(2));
  if (selection.kind === "partition") {
    await verifyPartitionManifest();
    await runPartition(selection.name);
    return;
  }
  if (selection.kind === "verify-all") {
    const verified = await verifyPartitionManifest();
    console.log(`Verified union: ${verified.counts.node} Node and ${verified.counts.vitest} Vitest files.`);
    for (const gate of Object.keys(gateManifests).sort()) {
      const counts = verified.gateCounts[gate];
      console.log(`${gate}: ${counts.node} Node and ${counts.vitest} Vitest files.`);
    }
    return;
  }
  const verified = await verifyGateManifest(selection.gate);
  console.log(`Verified ${verified.gate}: ${verified.counts.node} Node and ${verified.counts.vitest} Vitest files.`);
  for (const name of Object.keys(gateManifests[selection.gate]).sort()) {
    console.log(`${name}: ${partitionManifest[name].length}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
