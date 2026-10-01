import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRoot } from "./root-behavior.mjs";
import { run, withConsumer } from "./packed-consumer-helper.mjs";
import { strictDeclarations } from "./packed-declarations.mjs";
import { checkRuntimeClosure } from "./packed-runtime.mjs";
import { checkSnapshot } from "./snapshot-behavior.mjs";
import { compactFixtureSource } from "./compact-behavior.mjs";

test("packed root supports isolated ESM/CJS behavior and strict declarations", async () => {
  await withConsumer(async directory => {
    await checkRuntimeClosure(directory);
    for (const mode of ["esm", "cjs"]) {
      const filename = join(directory, `consumer.${mode === "esm" ? "mjs" : "cjs"}`);
      const prelude = mode === "esm"
        ? 'import * as engine from "@weaver-conf/config-engine"; import assert from "node:assert/strict";'
        : 'const engine = require("@weaver-conf/config-engine"); const assert = require("node:assert/strict");';
      await fs.writeFile(filename, `${prelude}\n(${checkRoot.toString()})(engine, assert);\n(${checkSnapshot.toString()})(engine, assert);\n${compactFixtureSource}\ncheckCompactSnapshots(engine, assert);`);
      run(process.execPath, [filename], directory);
    }
    const require = createRequire(join(directory, "package.json"));
    for (const subpath of ["layers", "namespace", "contract-derivation", "schema-registry",
      "json-schema-generator", "zod-schema-generator", "resolution-origins", "resolution-policy",
      "resolution-observation", "src/index.ts", "dist/index.js"]) {
      assert.throws(() => require.resolve(`@weaver-conf/config-engine/${subpath}`),
        { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    }
    await strictDeclarations(directory);
  });
});

test("owned temporary cleanup covers setup/callback/success and preserves errors and siblings", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "engine-cleanup-proof-"));
  try {
    const sibling = join(parent, "sibling");
    await fs.mkdir(sibling);
    const primary = new Error("primary");
    const setup = async directory => { await fs.writeFile(join(directory, "owned"), "owned"); };
    for (const phase of ["setup", "callback", "success", "cleanup-error"]) {
      let allocated;
      const options = { parent, setup: async directory => {
        allocated = directory;
        await setup(directory);
        if (phase === "setup") throw primary;
      }, remove: async (directory, flags) => {
        await fs.rm(directory, flags);
        if (phase === "cleanup-error") throw new Error("secondary");
      } };
      const callback = () => {
        if (phase !== "success") throw primary;
        return "result";
      };
      if (phase === "success") assert.equal(await withConsumer(callback, options), "result");
      else await assert.rejects(withConsumer(callback, options), error => error === primary);
      await assert.rejects(fs.access(allocated), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(parent), ["sibling"]);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
