import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { bootFixture, browserExports, fixture, installConsumer, requireTool, run } from "./packed-consumer-helper.mjs";
import { strictDeclarations } from "./packed-declarations.mjs";

async function runtimeImports(directory) {
  for (const [extension, statement] of [
    ["mjs", 'import * as api from "@weaver-conf/weaver-client/browser";'],
    ["cjs", 'const api = require("@weaver-conf/weaver-client/browser");'],
  ]) {
    const file = await fixture(directory, `smoke.${extension}`, `${statement}
if ("createFileSystemPersistence" in api) throw new Error("filesystem leaked");
if (JSON.stringify(Object.keys(api).sort()) !== ${JSON.stringify(JSON.stringify(browserExports))}) throw new Error("browser exports changed");
(async () => { ${bootFixture} })().catch(error => { console.error(error); process.exitCode = 1; });`);
    run(process.execPath, [file], directory);
  }
}

async function browserBundle(directory, mode) {
  const requireEsbuild = createRequire(requireTool.resolve("tsup"));
  const { build } = requireEsbuild("esbuild");
  const statement = mode === "esm"
    ? 'import * as api from "@weaver-conf/weaver-client/browser";'
    : 'const api = require("@weaver-conf/weaver-client/browser");';
  const name = `browser-fixture-${mode}.js`;
  const file = await fixture(directory, name, `${statement}
globalThis.browserProof = (async () => {
if ("createFileSystemPersistence" in api) throw new Error("filesystem leaked");
if (JSON.stringify(Object.keys(api).sort()) !== ${JSON.stringify(JSON.stringify(browserExports))}) throw new Error("browser exports changed");
${bootFixture}
return "awaited boot then sync get passed";
})();`);
  const result = await build({ entryPoints: [file], absWorkingDir: directory,
    bundle: true, platform: "browser", format: "iife", write: false,
    treeShaking: false, metafile: true });
  for (const [name, input] of Object.entries(result.metafile.inputs)) {
    assert.ok(name.includes("node_modules/") || name === `browser-fixture-${mode}.js`, name);
    assert.doesNotMatch(name, /fs-persistence|weaver-server|config-policy|storage-providers/);
    for (const imported of input.imports) assert.equal(imported.external, undefined, imported.path);
  }
  for (const output of Object.values(result.metafile.outputs)) assert.deepEqual(output.imports, []);
  const context = { console, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone };
  assert.equal(runInNewContext('typeof process + ":" + typeof Buffer + ":" + typeof require', context), "undefined:undefined:undefined");
  runInNewContext(result.outputFiles[0].text, context, { timeout: 10_000 });
  assert.equal(await context.browserProof, "awaited boot then sync get passed");
  console.log(`${mode} full unshaken browser graph: ${JSON.stringify(Object.keys(result.metafile.inputs))}`);
  console.log(`${mode} browser platform bundle executed without Node globals: ${Object.keys(result.metafile.inputs).length} inputs; zero externals`);
  console.log(`${mode} browser exports: ${JSON.stringify(browserExports)}`);
}

test("packed browser public boundary: ESM/CJS, strict NodeNext/Bundler and executed browser bundles", async () => {
  const directory = await installConsumer();
  try {
    await runtimeImports(directory);
    for (const mode of ["esm", "cjs"]) await browserBundle(directory, mode);
    await strictDeclarations(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
