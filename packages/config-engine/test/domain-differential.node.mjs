import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import * as current from "@weaver-conf/config-types";
import * as engine from "../dist/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function pinned(entry) {
  const result = await build({ entryPoints: [join(root, entry)], bundle: true, write: false, format: "esm", platform: "node",
    plugins: [{ name: "actual-pinned-source", setup(builder) {
      builder.onResolve({ filter: /^@weaver-conf\/config-types$/ }, () => ({ path: join(root, "packages/config-types/src/index.ts") }));
      builder.onLoad({ filter: /packages\/config-(?:types|engine)\/src\/.*\.ts$/ }, args => ({
        contents: execFileSync("git", ["show", `443ab01efb4c8f8226ab797e56655ba85e255593:${relative(root, args.path)}`], { cwd: root, encoding: "utf8" }), loader: "ts" }));
    } }] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

test("ordinary path/identity/DTO corpus matches actual443ab01 authority without fixture recapture", async () => {
  const before = await pinned("packages/config-types/src/index.ts");
  const oldEngine = await pinned("packages/config-engine/src/registration-paths.ts");
  const paths = ["", "/", "/example", "/example/", "/example/literal.dot", "/example/😀", "/example/é", "/example/e\u0301",
    "/a//b", "/_weaver", "/a/_weaver", "/a/constructor", "/a/[b]", "/a/..", "/a/.", "/a/01", null, 1, {}];
  const names = ["publicConfigPathSchema", "slotPathSchema", "canonicalConfigurationPathSchema"];
  let comparisons = 0;
  for (const name of names) for (const path of paths) {
    assert.equal(current[name].safeParse(path).success, before[name].safeParse(path).success, `${name}:${JSON.stringify(path)}`);
    comparisons++;
  }
  for (const path of paths.filter(value => typeof value === "string")) {
    const run = api => { try { return { success: true, value: api.parseCanonicalConfigPath(path) }; } catch { return { success: false }; } };
    assert.deepEqual(run(engine), run(oldEngine)); comparisons++;
  }
  const identity = { environment: "test:雪", scopePath: [{ scopeId: "tenant", value: "" }, { scopeId: "site", value: "a" }] };
  const identities = [identity, { ...identity, scopePath: [...identity.scopePath].reverse() }, { ...identity, scopePath: [] },
    { ...identity, scopePath: [identity.scopePath[0], identity.scopePath[0]] }, { ...identity, extra: true }, { ...identity, environment: "constructor" }];
  for (const value of identities) {
    const after = current.configurationServiceIdentitySchema.safeParse(value), old = before.configurationServiceIdentitySchema.safeParse(value);
    assert.equal(after.success, old.success);
    if (after.success) assert.deepEqual(after.data, old.data);
    comparisons++;
  }
  console.log(`actual pinned ordinary corpus: ${comparisons} exact acceptance/output comparisons`);
});
