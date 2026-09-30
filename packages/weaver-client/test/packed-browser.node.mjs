import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { bootFixture, fixture, installConsumer, requireTool, run } from "./packed-consumer-helper.mjs";

async function runtimeImports(directory) {
  for (const [extension, statement] of [
    ["mjs", 'import * as api from "@weaver-conf/weaver-client/browser";'],
    ["cjs", 'const api = require("@weaver-conf/weaver-client/browser");'],
  ]) {
    const file = await fixture(directory, `smoke.${extension}`, `${statement}
if ("createFileSystemPersistence" in api) throw new Error("filesystem leaked");
(async () => { ${bootFixture} })().catch(error => { console.error(error); process.exitCode = 1; });`);
    run(process.execPath, [file], directory);
  }
}

async function strictDeclarations(directory) {
  const text = `import { createWeaverClient, createLocalTransport, createIndexedDbPersistence,
type WeaverClientPersistence } from "@weaver-conf/weaver-client/browser";
import { createFileSystemPersistence } from "@weaver-conf/weaver-client";
// @ts-expect-error The browser boundary must not expose filesystem persistence.
import { createFileSystemPersistence as forbidden } from "@weaver-conf/weaver-client/browser";
// @ts-expect-error Node-only options must not leak either.
import type { FileSystemPersistenceOptions } from "@weaver-conf/weaver-client/browser";
const persistence: WeaverClientPersistence = createIndexedDbPersistence({ dbName: "test" });
const nodePersistence: WeaverClientPersistence = createFileSystemPersistence({ directory: "cache" });
const transport = createLocalTransport({ snapshot: { entries: {}, scopes: {}, revision: "1", timestamp: "now" } });
const boot = createWeaverClient({ transport, persistence });
void boot; void nodePersistence;`;
  for (const extension of ["mts", "cts"]) {
    const file = await fixture(directory, `types.${extension}`, text);
    run(process.execPath, [requireTool.resolve("typescript/bin/tsc"), "--strict", "--noEmit",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", file], directory);
  }
}

async function browserBundle(directory) {
  const requireEsbuild = createRequire(requireTool.resolve("tsup"));
  const { build } = requireEsbuild("esbuild");
  const file = await fixture(directory, "browser-fixture.js", `import * as api from "@weaver-conf/weaver-client/browser";
globalThis.browserProof = (async () => {
if ("createFileSystemPersistence" in api) throw new Error("filesystem leaked");
${bootFixture}
return "awaited boot then sync get passed";
})();`);
  const result = await build({ entryPoints: [file], absWorkingDir: directory,
    bundle: true, platform: "browser", format: "iife", write: false,
    treeShaking: false, metafile: true });
  for (const [name, input] of Object.entries(result.metafile.inputs)) {
    assert.ok(name.includes("node_modules/") || name === "browser-fixture.js", name);
    for (const imported of input.imports) assert.equal(imported.external, undefined, imported.path);
  }
  for (const output of Object.values(result.metafile.outputs)) assert.deepEqual(output.imports, []);
  const context = { console, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone };
  runInNewContext(result.outputFiles[0].text, context, { timeout: 10_000 });
  assert.equal(await context.browserProof, "awaited boot then sync get passed");
  console.log(`browser platform bundle executed without Node globals: ${Object.keys(result.metafile.inputs).length} inputs; zero externals`);
}

test("packed browser public boundary: ESM/CJS, strict NodeNext and executed browser bundle", async () => {
  const directory = await installConsumer();
  try {
    await runtimeImports(directory);
    await browserBundle(directory);
    await strictDeclarations(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
