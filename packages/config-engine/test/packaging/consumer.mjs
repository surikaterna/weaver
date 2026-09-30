import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = resolve(packageDir, "../..");
export const toolRequire = createRequire(join(workspace, "package.json"));

export function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8" });
}

export async function withConsumer(callback) {
  const consumer = await mkdtemp(join(tmpdir(), "engine-packed-"));
  try {
    const tarballs = {};
    for (const name of ["config-types", "config-engine"]) {
      const directory = join(workspace, "packages", name);
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      const packed = JSON.parse(run("pnpm", ["pack", "--pack-destination", consumer, "--json"], directory));
      tarballs[manifest.name] = `file:${packed.filename}`;
    }
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: tarballs }));
    // Only the consumer overrides unpublished versions with real packed artifacts.
    await writeFile(join(consumer, "pnpm-workspace.yaml"), JSON.stringify({ packages: [], overrides: tarballs }));
    run("pnpm", ["install", "--ignore-scripts"], consumer);
    await callback(consumer);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

export async function assertInstalled(path, consumer) {
  const actual = await realpath(path);
  assert.ok(actual.startsWith(`${consumer}/node_modules/`), actual);
  assert.ok(!actual.includes(workspace), actual);
  console.log(`isolated artifact: ${actual}`);
}
