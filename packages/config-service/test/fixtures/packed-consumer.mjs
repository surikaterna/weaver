import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../../", import.meta.url));
export const tooling = createRequire(join(root, "package.json"));
export function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
}
async function closure(name, manifests = new Map()) {
  if (manifests.has(name)) return manifests;
  const source = join(root, "packages", name), manifest = JSON.parse(await fs.readFile(join(source, "package.json"), "utf8"));
  manifests.set(name, { source, manifest });
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    if (dependency.startsWith("@weaver-conf/")) await closure(dependency.slice(13), manifests);
  return manifests;
}
async function prepare(directory, execute, write, resolve) {
  const dependencies = {}, manifests = await closure("config-service"); await closure("storage-providers", manifests);
  for (const [name, { source, manifest }] of manifests) {
    execute("pnpm", ["pack", "--pack-destination", directory], source);
    const tarball = join(directory, `weaver-conf-${name}-${manifest.version}.tgz`);
    console.log(`packed sha256 ${manifest.name}@${manifest.version}: ${createHash("sha256").update(await fs.readFile(tarball)).digest("hex")}`);
    dependencies[manifest.name] = `file:${tarball}`;
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {}))
      if (!dependency.startsWith("@weaver-conf/")) dependencies[dependency] = range;
  }
  await write(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
  await write(join(directory, "pnpm-workspace.yaml"), `packages: []\nlinkWorkspacePackages: false\nautoInstallPeers: false\noverrides:\n${Object.entries(dependencies).filter(([, value]) => value.startsWith("file:")).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join("\n")}\n`);
  execute("pnpm", ["install", "--ignore-scripts", "--config.confirmModulesPurge=false"], directory);
  const require = createRequire(join(directory, "package.json"));
  for (const name of Object.keys(dependencies)) {
    const path = await resolve(require.resolve(name));
    assert.ok(path.startsWith(`${directory}${sep}node_modules${sep}`), path);
    console.log(`packed installed runtime: ${name} -> ${path}`);
  }
}
export async function withConsumer(callback, { parent = tmpdir(), execute = run, write = fs.writeFile, resolve = fs.realpath } = {}) {
  const directory = await fs.mkdtemp(join(parent, "weaver-hydration-packed-"));
  try {
    await prepare(directory, execute, write, resolve);
    const result = await callback(directory);
    await fs.rm(directory, { recursive: true, force: true });
    return result;
  } catch (error) {
    try { await fs.rm(directory, { recursive: true, force: true }); }
    finally { throw error; }
  }
}
