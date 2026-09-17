import { spawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import {
  partitionManifest,
  partitionSuites,
  verifyPartitionManifest,
} from "./partition-manifest.mjs";

export function parseRunnerArgs(args) {
  if (args.length !== 1) throw new Error("Expected exactly one partition name or 'verify'");
  const [name] = args;
  if (name === "verify") return Object.freeze({ kind: "verify" });
  if (!(name in partitionManifest)) throw new Error(`Unknown test partition: ${name}`);
  return Object.freeze({ kind: "partition", name });
}

function commandFor(name) {
  const files = partitionManifest[name];
  if (partitionSuites[name] === "node") {
    return ["node", ["--import", "tsx", "--test", "--test-concurrency=1", ...files]];
  }
  return ["pnpm", ["exec", "vitest", "run", "--maxWorkers=1", "--no-file-parallelism", ...files]];
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
  const verified = await verifyPartitionManifest();
  if (selection.kind === "partition") {
    await runPartition(selection.name);
    return;
  }
  console.log(`Verified ${verified.counts.node} Node and ${verified.counts.vitest} Vitest files.`);
  for (const name of Object.keys(partitionManifest).sort()) {
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
