import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { assertInstalled, toolRequire } from "./packed-consumer-helper.mjs";
import { runInNewContext } from "node:vm";
import { checkSnapshot } from "./snapshot-behavior.mjs";
import { compactFixtureSource } from "./compact-behavior.mjs";
import { validationFixtureSource } from "./validation-regressions.mjs";

const esbuild = createRequire(toolRequire.resolve("tsup"))("esbuild");

async function browserClosure(entry, directory, globalName) {
    const result = await esbuild.build({ entryPoints: [entry], absWorkingDir: directory,
      bundle: true, platform: "browser", format: "iife", globalName, treeShaking: false, write: false, metafile: true });
    assert.ok(Object.keys(result.metafile.inputs).length > 1);
    for (const path of Object.keys(result.metafile.inputs)) {
      await assertInstalled(resolve(directory, path), directory);
    }
    for (const output of Object.values(result.metafile.outputs)) {
      assert.deepEqual(output.imports, [], "No external runtime aliases or builtins");
    }
    console.log(`no-alias browser runtime closure: ${entry}, ${Object.keys(result.metafile.inputs).length} files`);
    return result.outputFiles[0].text;
}

export async function checkRuntimeClosure(directory) {
  const require = createRequire(join(directory, "package.json"));
  const cjs = require.resolve("@weaver-conf/config-engine");
  const esm = join(dirname(cjs), "index.js");
  const sessionCjs = require.resolve("@weaver-conf/config-engine/internal/schema-validation-session");
  const sessionEsm = join(dirname(sessionCjs), "schema-validation-session.js");
  for (const [entry, sessionEntry] of [[esm, sessionEsm], [cjs, sessionCjs]]) {
    const text = await browserClosure(entry, directory, "engine");
    const session = await browserClosure(sessionEntry, directory, "validationSession");
    const sandbox = { assert };
    const cases = runInNewContext(`${text}\n${session}\n(${checkSnapshot.toString()})(engine, assert);\n${compactFixtureSource}\ncheckCompactSnapshots(engine, assert);\n${validationFixtureSource}\nexerciseValidationCache(engine, validationSession.createConfigurationValidationSession);\nexerciseValidation(engine);`, sandbox);
    console.log(`real browser validation ${entry}:`, cases, "and explicit cached mutations");
  }
}
