import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertInstalled, withConsumer } from "./consumer.mjs";
import { checkBrowserDeclarations, checkNodeDeclarations } from "./declarations.mjs";
import { checkRuntime } from "./runtime.mjs";

test("packed root preserves exports, Node errors and isolated browser/Node declarations", async (t) => {
  await withConsumer(async (consumer) => {
    const require = createRequire(join(consumer, "package.json"));
    const cjs = require.resolve("@weaver-conf/config-engine");
    const esm = join(consumer, "node_modules/@weaver-conf/config-engine/dist/index.js");
    const snapshot = JSON.parse(await readFile(new URL("./exports.json", import.meta.url), "utf8"));
    for (const [mode, path] of [["esm", esm], ["cjs", cjs]]) {
      await assertInstalled(path, consumer);
      const engine = mode === "esm" ? await import(pathToFileURL(path).href) : require(path);
      assert.deepEqual(Object.keys(engine).sort(), snapshot);
      console.log(`public ${mode} exports: ${Object.keys(engine).sort().join(", ")}`);
      await t.test(`${mode} real Node errors and structural validation`, () => checkRuntime(engine, consumer));
    }
    await t.test("strict browser NodeNext mts/cts and Bundler without Node types", () => checkBrowserDeclarations(consumer));
    await t.test("actual Node types are bidirectionally assignable", () => checkNodeDeclarations(consumer));
  });
});
