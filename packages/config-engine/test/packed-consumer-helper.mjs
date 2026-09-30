import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const toolRequire = createRequire(join(root, "package.json"));
export function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
}

async function packClosure(name, directory, records = new Map()) {
  if (records.has(name)) return records;
  const source = join(root, "packages", name);
  const manifest = JSON.parse(await fs.readFile(join(source, "package.json"), "utf8"));
  const packed = JSON.parse(run("pnpm", ["pack", "--pack-destination", directory, "--json"], source));
  const tarball = packed.filename;
  records.set(name, { manifest, tarball });
  console.log(`packed sha256 ${manifest.name}@${manifest.version}: ${createHash("sha256")
    .update(await fs.readFile(tarball)).digest("hex")}`);
  assert.doesNotMatch(run("tar", ["-tzf", tarball], directory), /(?:^|\n)package\/src\//);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@weaver-conf/")) await packClosure(dependency.slice(13), directory, records);
  }
  return records;
}

export async function assertInstalled(path, directory) {
  const actual = await fs.realpath(path);
  assert.ok(actual.startsWith(`${directory}${sep}node_modules${sep}`), actual);
  assert.ok(!actual.startsWith(root), actual);
  console.log(`packed provenance: ${actual}`);
  return actual;
}

async function prepare(directory) {
  const records = await packClosure("config-engine", directory);
  const dependencies = Object.fromEntries([...records.values()]
    .map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]));
  await fs.writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
  await fs.writeFile(join(directory, "pnpm-workspace.yaml"), JSON.stringify({ packages: [],
    linkWorkspacePackages: false, overrides: dependencies }));
  run("pnpm", ["install", "--ignore-scripts"], directory);
  const require = createRequire(join(directory, "package.json"));
  for (const { manifest } of records.values()) {
    const installed = join(directory, "node_modules", manifest.name, "package.json");
    await assertInstalled(installed, directory);
    const actual = JSON.parse(await fs.readFile(installed, "utf8"));
    assert.equal(actual.version, manifest.version);
    assert.deepEqual(actual.exports, manifest.exports);
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const expected = range === "workspace:*" ? [...records.values()]
        .find(record => record.manifest.name === name).manifest.version : range;
      assert.equal(actual.dependencies[name], expected);
      assert.doesNotMatch(actual.dependencies[name], /workspace:|link:|file:/);
      const packageRequire = createRequire(await fs.realpath(installed));
      await assertInstalled(packageRequire.resolve(name), directory);
    }
    await assertInstalled(require.resolve(manifest.name), directory);
  }
  const lock = await fs.readFile(join(directory, "pnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(lock, /workspace:|link:/);
  assert.ok(!lock.includes(root), "Consumer lock must not refer to the repository");
}

export async function withConsumer(callback, { parent = tmpdir(), setup = prepare,
  remove = fs.rm } = {}) {
  const directory = await fs.mkdtemp(join(parent, "weaver-engine-root-"));
  let result;
  try {
    await setup(directory);
    result = await callback(directory);
  } catch (error) {
    try { await remove(directory, { recursive: true, force: true }); }
    finally { throw error; }
  }
  await remove(directory, { recursive: true, force: true });
  return result;
}
