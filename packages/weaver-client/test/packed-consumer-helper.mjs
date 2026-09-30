import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const packages = ["config-types", "config-engine", "config-runtime", "config-sync", "weaver-client"];
export const requireTool = createRequire(join(root, "package.json"));

export function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function installConsumer() {
  const directory = await mkdtemp(join(tmpdir(), "weaver-browser-packed-"));
  const dependencies = {};
  for (const name of packages) {
    const source = join(root, "packages", name);
    run("pnpm", ["pack", "--pack-destination", directory], source);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    dependencies[manifest.name] = `file:${join(directory, `weaver-conf-${name}-${manifest.version}.tgz`)}`;
  }
  await writeFile(join(directory, "package.json"), JSON.stringify({
    private: true, type: "module", dependencies,
  }));
  // Unpublished alpha versions resolve to packed artifacts, never workspace sources.
  await writeFile(join(directory, "pnpm-workspace.yaml"),
    `packages: []\nlinkWorkspacePackages: false\noverrides:\n${Object.entries(dependencies)
      .map(([name, tarball]) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarball)}`).join("\n")}\n`);
  try {
    run("pnpm", ["install", "--ignore-scripts", "--config.confirmModulesPurge=false"], directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const consumerRequire = createRequire(join(directory, "package.json"));
  for (const name of packages) {
    const resolved = await realpath(consumerRequire.resolve(`@weaver-conf/${name}`));
    assert.ok(resolved.startsWith(`${directory}/node_modules/`), resolved);
    assert.ok(resolved.includes("/dist/"), resolved);
    console.log(`packed resolution: ${name} -> ${resolved}`);
  }
  return directory;
}

export async function fixture(directory, name, text) {
  const path = join(directory, name);
  await writeFile(path, text);
  return path;
}

export const snapshot = {
  entries: { app: { enabled: true } }, scopes: {},
  revision: "packed-1", timestamp: "2026-09-30T00:00:00.000Z",
};

export const bootFixture = `
const client = await api.createWeaverClient({
  transport: api.createLocalTransport({ snapshot: ${JSON.stringify(snapshot)} }),
});
if (client.get("app.enabled") !== true) throw new Error("awaited boot/sync get failed");
await client.close();
`;
