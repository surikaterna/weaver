import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const fixtureRoot = join(packageRoot, "test/fixtures/packed-consumer");
const pnpmCli = process.env.npm_execpath;

let temporaryRoot;
let consumerRoot;

async function runPnpm(arguments_, cwd) {
  assert.ok(pnpmCli, "pnpm must provide npm_execpath to the test process");
  try {
    return await execFileAsync(process.execPath, [pnpmCli, ...arguments_], {
      cwd,
      env: { ...process.env, CI: "true" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof Error && "stderr" in error && "stdout" in error) {
      throw new Error(
        `${error.message}\n${String(error.stdout)}\n${String(error.stderr)}`,
      );
    }
    throw error;
  }
}

async function packPackage(sourceRoot, packRoot) {
  const before = new Set(await readdir(packRoot));
  await runPnpm(["pack", "--pack-destination", packRoot], sourceRoot);
  const archive = (await readdir(packRoot)).find(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  assert.ok(archive, `pnpm pack did not create an archive for ${sourceRoot}`);
  return join(packRoot, archive);
}

async function installPackedDependencies(packRoot) {
  const configTypesArchive = await packPackage(
    join(workspaceRoot, "packages/config-types"),
    packRoot,
  );
  const configEngineArchive = await packPackage(packageRoot, packRoot);
  const manifestPath = join(consumerRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const configTypesReference = `file:${relative(
    consumerRoot,
    configTypesArchive,
  )}`;
  const configEngineReference = `file:${relative(
    consumerRoot,
    configEngineArchive,
  )}`;

  manifest.dependencies = {
    "@weaver-conf/config-engine": configEngineReference,
    "@weaver-conf/config-types": configTypesReference,
    zod: "4.4.3",
  };
  manifest.devDependencies = {
    "@types/node": "26.5.1",
    typescript: "5.9.3",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  await writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "."\noverrides:\n  "@weaver-conf/config-types": "${configTypesReference}"\n`,
  );

  await runPnpm(
    [
      "install",
      "--ignore-scripts",
    ],
    consumerRoot,
  );
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "config-engine-packed-"));
  consumerRoot = join(temporaryRoot, "consumer");
  const packRoot = join(temporaryRoot, "packs");
  await mkdir(packRoot);
  await cp(fixtureRoot, consumerRoot, { recursive: true });
  await installPackedDependencies(packRoot);
}, 120_000);

afterAll(async () => {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("resolves the packed package entirely inside the temporary consumer", async () => {
  const requireFromConsumer = createRequire(join(consumerRoot, "consumer.cjs"));
  const entryPath = await realpath(
    requireFromConsumer.resolve("@weaver-conf/config-engine"),
  );
  const installedPackageRoot = resolve(dirname(entryPath), "..");
  const consumerManifestSource = await readFile(
    join(consumerRoot, "package.json"),
    "utf8",
  );
  const consumerManifest = JSON.parse(consumerManifestSource);
  const manifest = JSON.parse(
    await readFile(join(installedPackageRoot, "package.json"), "utf8"),
  );

  expect(entryPath.startsWith(consumerRoot)).toBe(true);
  expect(entryPath.startsWith(workspaceRoot)).toBe(false);
  expect(consumerManifestSource).not.toMatch(/(?:workspace|link):/);
  expect(consumerManifest.dependencies["@weaver-conf/config-engine"]).toMatch(
    /^file:.*\.tgz$/,
  );
  expect(consumerManifest.dependencies["@weaver-conf/config-types"]).toMatch(
    /^file:.*\.tgz$/,
  );
  expect(manifest.dependencies["@weaver-conf/config-types"]).toBe("0.1.2");
  expect(manifest.dependencies.zod).toBe("^4.0.0");
  await expect(access(join(installedPackageRoot, "src"))).rejects.toThrow();
});

test("runs the packed ESM root", async () => {
  await runPnpm(["run", "check:esm"], consumerRoot);
});

test("runs the packed CommonJS root", async () => {
  await runPnpm(["run", "check:cjs"], consumerRoot);
});

test("typechecks packed declarations with strict NodeNext resolution", async () => {
  await runPnpm(["run", "check:types"], consumerRoot);
});
