import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { createContext, runInContext, runInThisContext } from "node:vm";
import { tooling } from "./packed-consumer.mjs";

const { build } = tooling("esbuild");
export async function browserProof(directory) {
  const text = await readFile(new URL("browser-entry.mjs", import.meta.url), "utf8");
  for (const cjs of [false, true]) {
    const contents = cjs ? text.replace('import * as service from "@weaver-conf/config-service";', 'const service = require("@weaver-conf/config-service");').replace('import * as admission from "@weaver-conf/config-service/admission";', 'const admission = require("@weaver-conf/config-service/admission");') : text;
    const result = await build({ stdin: { contents, resolveDir: directory, sourcefile: "entry.mjs", loader: "js" }, absWorkingDir: directory, bundle: true, platform: "browser", format: "iife", globalName: "proof", treeShaking: false, write: false, metafile: true });
    for (const [path, input] of Object.entries(result.metafile.inputs)) {
      assert.doesNotMatch(path, /weaver-client|storage-providers|weaver-server|fs-persistence/);
      if (path !== "entry.mjs") assert.ok((await realpath(join(directory, path))).startsWith(`${directory}${sep}node_modules${sep}`));
      for (const imported of input.imports) { assert.equal(imported.external, undefined); assert.doesNotMatch(imported.path, /^(node:|fs$|path$)/); }
    }
    for (const output of Object.values(result.metafile.outputs)) assert.equal(output.imports.length, 0);
    console.log(`unshaken ${cjs ? "CJS" : "ESM"} browser graph ${Object.keys(result.metafile.inputs).length} inputs: ${JSON.stringify(result.metafile)}`);
    const context = createContext({ console, setInterval, clearInterval, setTimeout, clearTimeout, crypto: globalThis.crypto, structuredClone });
    runInContext(result.outputFiles[0].text, context);
    assert.equal(runInContext("typeof process + '/' + typeof Buffer + '/' + typeof require", context), "undefined/undefined/undefined");
    assert.equal(JSON.stringify(context.proof.exports), JSON.stringify(["configurationServiceHostBindingSchema", "configurationServiceHostOptionsSchema", "createConfigurationService"]));
    assert.ok(context.proof.admissionExports.includes("prepareConfigMutation"));
    const outcome = await context.proof.exercise(); assert.equal(outcome.synchronous, true); assert.equal(outcome.winner, "later");
    // VM contexts have no native structuredClone; borrowed clones have foreign prototypes.
    // Exercise the same complete browser bundle with genuine same-realm intrinsics.
    const native = runInThisContext(`(() => { ${result.outputFiles[0].text}\n return proof; })()`);
    await native.exerciseWrites();
  }
}
