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
  const env = { ...process.env, NODE_PATH: "" };
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
}

async function packClosure(directory, packDirectory, seen = new Set()) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (seen.has(manifest.name)) return {};
  seen.add(manifest.name);
  const tarballs = {};
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!version.startsWith("workspace:")) continue;
    Object.assign(tarballs, await packClosure(join(workspace, "packages", name.split("/")[1]), packDirectory, seen));
  }
  const output = JSON.parse(run("pnpm", ["pack", "--pack-destination", packDirectory, "--json"], directory));
  tarballs[manifest.name] = `file:${output.filename}`;
  return tarballs;
}

export async function withConsumer(callback) {
  const temporary = await mkdtemp(join(tmpdir(), "policy-packed-"));
  try {
    const tarballs = await packClosure(packageDir, temporary);
    // Pin unpublished runtime closure to packed artifacts, never workspace sources.
    await writeFile(join(temporary, "package.json"), JSON.stringify({
      private: true, type: "module", dependencies: tarballs,
    }));
    await writeFile(join(temporary, "pnpm-workspace.yaml"), JSON.stringify({ packages: [], overrides: tarballs }));
    run("pnpm", ["install", "--ignore-scripts"], temporary);
    await callback(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function assertInstalled(path, consumer) {
  const actual = await realpath(path);
  assert.ok(actual.startsWith(`${consumer}/node_modules/`), actual);
  assert.ok(!actual.includes(workspace), actual);
  console.log(`isolated artifact: ${actual}`);
}
