import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { assertInstalled, toolRequire } from "./packed-consumer-helper.mjs";

const esbuild = createRequire(toolRequire.resolve("tsup"))("esbuild");

export async function checkRuntimeClosure(directory) {
  const require = createRequire(join(directory, "package.json"));
  const cjs = require.resolve("@weaver-conf/config-engine");
  const esm = join(dirname(cjs), "index.js");
  for (const entry of [esm, cjs]) {
    const result = await esbuild.build({ entryPoints: [entry], absWorkingDir: directory,
      bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
    assert.ok(Object.keys(result.metafile.inputs).length > 1);
    for (const path of Object.keys(result.metafile.inputs)) {
      await assertInstalled(resolve(directory, path), directory);
    }
    for (const output of Object.values(result.metafile.outputs)) {
      assert.deepEqual(output.imports, [], "No external runtime aliases or builtins");
    }
    console.log(`no-alias browser runtime closure: ${entry}, ${Object.keys(result.metafile.inputs).length} files`);
  }
}
