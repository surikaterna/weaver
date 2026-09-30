import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { createContext, runInContext } from "node:vm";
import { exercise, internalExports, rootExports } from "./operation-support-fixture.mjs";
import { fixture, requireTool } from "./packed-consumer-helper.mjs";

const { build } = requireTool("esbuild");

export async function browserGraphs(directory) {
  const resolve = createRequire(join(directory, "package.json")).resolve;
  for (const [boundary, specifier] of [["root", "@weaver-conf/config-registry"],
    ["internal", "@weaver-conf/config-registry/internal/server-adapter"]]) {
    for (const mode of ["esm", "cjs"]) {
      const cjs = mode === "cjs";
      const entry = await fixture(directory, `${boundary}-${mode}.${cjs ? "cjs" : "mjs"}`,
        cjs ? `const api = require('${specifier}'); const support = require('@weaver-conf/config-registry');
          const engine = require('@weaver-conf/config-engine'); module.exports = { api, support, engine };`
          : `import * as api from '${specifier}'; import * as support from '@weaver-conf/config-registry';
          import * as engine from '@weaver-conf/config-engine'; export { api, support, engine };`);
      const result = await build({ entryPoints: [entry], absWorkingDir: directory, bundle: true, write: false,
        treeShaking: false, platform: "browser", format: "iife", globalName: "packed", metafile: true });
      const imports = [...Object.values(result.metafile.inputs), ...Object.values(result.metafile.outputs)]
        .flatMap(item => item.imports);
      assert.equal(imports.some(item => item.external), false);
      const inputs = Object.keys(result.metafile.inputs);
      assert.equal(inputs.some(input => /weaver-server|storage-provider|config-runtime|node:|fs-persistence/.test(input)), false);
      for (const input of inputs) {
        const path = await realpath(join(directory, input));
        assert.ok(path === entry || path.startsWith(`${directory}${sep}node_modules${sep}`), path);
      }
      const registryPath = resolve(specifier).replace(/\.cjs$/, cjs ? ".cjs" : ".js");
      assert.ok(inputs.some(input => join(directory, input) === registryPath), registryPath);
      console.log(`packed full ${boundary} ${mode} metafile: ${JSON.stringify(result.metafile)}`);
      const context = createContext({ crypto: webcrypto, structuredClone });
      runInContext(result.outputFiles[0].text, context);
      runInContext(`const { api, support, engine } = packed;
        if (typeof process !== 'undefined' || typeof Buffer !== 'undefined' || typeof require !== 'undefined') throw Error('Node globals');
        ${exercise}`, context);
      const keys = JSON.parse(runInContext("JSON.stringify(Object.keys(api).sort())", context));
      assert.deepEqual(keys, boundary === "root" ? rootExports : internalExports);
      console.log(`packed ${boundary} ${mode}: ${inputs.length} full inputs, zero externals, real WebCrypto/engine`);
    }
  }
}
