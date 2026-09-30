import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { exerciseBrowser } from "./behavior.mjs";
import { checkBrowserBundle } from "./browser-bundle.mjs";
import { assertInstalled, run, withConsumer } from "./consumer.mjs";
import { checkDeclarations } from "./declarations.mjs";
import { checkFilesystem } from "./node-filesystem.mjs";

test("packed browser and Node entries in an isolated public consumer", async (t) => {
  await withConsumer(async (consumer) => {
    const require = createRequire(join(consumer, "package.json"));
    const resolveEsm = (name) => run("node", ["--input-type=module", "-e",
      `console.log(import.meta.resolve(${JSON.stringify(name)}))`], consumer).trim();
    for (const mode of ["esm", "cjs"]) {
      await t.test(`${mode} browser runtime and complete browser bundle`, async () => {
        const name = "@weaver-conf/config-policy/browser";
        const path = mode === "esm" ? new URL(resolveEsm(name)).pathname : require.resolve(name);
        await assertInstalled(path, consumer);
        const api = mode === "esm" ? await import(pathToFileURL(path).href) : require(name);
        await exerciseBrowser(api);
        await checkBrowserBundle(consumer, mode);
      });
      await t.test(`${mode} Node root real filesystem persistence`, async () => {
        const name = "@weaver-conf/config-policy";
        const path = mode === "esm" ? new URL(resolveEsm(name)).pathname : require.resolve(name);
        await assertInstalled(path, consumer);
        const api = mode === "esm" ? await import(pathToFileURL(path).href) : require(name);
        await checkFilesystem(api, consumer, mode);
      });
    }
    for (const mode of ["esm", "cjs", "browser"]) {
      await t.test(`strict ${mode} declarations`, () => checkDeclarations(consumer, mode));
    }
  });
});
