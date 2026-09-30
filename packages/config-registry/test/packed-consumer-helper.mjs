import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const requireTool = createRequire(join(root, "package.json"));
export function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
}

async function closure(name, manifests = new Map()) {
  if (manifests.has(name)) return manifests;
  const source = join(root, "packages", name);
  const manifest = JSON.parse(await fs.readFile(join(source, "package.json"), "utf8"));
  manifests.set(name, { source, manifest });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@weaver-conf/")) await closure(dependency.slice(13), manifests);
  }
  return manifests;
}

async function prepare(directory, execute, write, resolve) {
  const dependencies = {};
  for (const [name, { source, manifest }] of await closure("config-registry")) {
    execute("pnpm", ["pack", "--pack-destination", directory], source);
    dependencies[manifest.name] = `file:${join(directory, `weaver-conf-${name}-${manifest.version}.tgz`)}`;
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@weaver-conf/")) dependencies[dependency] = range;
    }
  }
  await write(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
  await write(join(directory, "pnpm-workspace.yaml"),
    `packages: []\nlinkWorkspacePackages: false\noverrides:\n${Object.entries(dependencies)
      .filter(([, tarball]) => tarball.startsWith("file:"))
      .map(([name, tarball]) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarball)}`).join("\n")}\n`);
  execute("pnpm", ["install", "--ignore-scripts", "--config.confirmModulesPurge=false"], directory);
  const consumerRequire = createRequire(join(directory, "package.json"));
  for (const name of [...Object.keys(dependencies), "@weaver-conf/config-registry/internal/server-adapter"]) {
    const resolved = await resolve(consumerRequire.resolve(name));
    assert.ok(resolved.startsWith(`${directory}${sep}node_modules${sep}`), resolved);
    console.log(`packed runtime resolution: ${name} -> ${resolved}`);
  }
}

export async function installConsumer({ parent = tmpdir(), execute = run,
  write = fs.writeFile, resolve = fs.realpath } = {}) {
  const directory = await fs.mkdtemp(join(parent, "weaver-registry-packed-"));
  try {
    await prepare(directory, execute, write, resolve);
    return directory;
  } catch (error) {
    try { await fs.rm(directory, { recursive: true, force: true }); }
    finally { throw error; }
  }
}

export async function withConsumer(callback, options) {
  const directory = await installConsumer(options);
  let result;
  try { result = await callback(directory); }
  catch (error) {
    try { await fs.rm(directory, { recursive: true, force: true }); }
    finally { throw error; }
  }
  await fs.rm(directory, { recursive: true, force: true });
  return result;
}

export async function fixture(directory, name, text) {
  const path = join(directory, name);
  await fs.writeFile(path, text);
  return path;
}
