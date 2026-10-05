import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { assertInstalled, toolRequire } from "./consumer.mjs";

const esbuild = createRequire(toolRequire.resolve("tsup"))("esbuild");

export async function checkBrowserBundle(consumer, mode) {
  const behaviorPath = join(consumer, "behavior.mjs");
  await writeFile(behaviorPath, await readFile(new URL("./behavior.mjs", import.meta.url)));
  const entry = join(consumer, `entry-${mode}.mjs`);
  const load = mode === "esm"
    ? "import * as api from '@weaver-conf/config-policy/browser';"
    : "const api = require('@weaver-conf/config-policy/browser');";
  await writeFile(entry, `${load}\nimport { exerciseBrowser } from './behavior.mjs';
globalThis.finished = exerciseBrowser(api);`);
  const bundle = await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "browser", format: "iife",
    write: false, metafile: true, treeShaking: false, absWorkingDir: consumer,
  });
  for (const [path, input] of Object.entries(bundle.metafile.inputs)) {
    assert.ok(!/fs-override|config-server|weaver-server|mongodb|git-provider/.test(path), path);
    for (const dependency of input.imports) {
      assert.ok(!dependency.external && !isBuiltin(dependency.path), dependency.path);
    }
    if (path.includes("node_modules")) await assertInstalled(join(consumer, path), consumer);
  }
  console.log(`browser ${mode} complete graph: ${JSON.stringify(bundle.metafile)}`);
  const context = createContext({});
  assert.equal(runInContext("typeof process + ',' + typeof Buffer + ',' + typeof require", context), "undefined,undefined,undefined");
  runInContext(bundle.outputFiles[0].text, context, { timeout: 5000 });
  await context.finished;
}
