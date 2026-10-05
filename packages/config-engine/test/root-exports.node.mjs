import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import * as esm from "@weaver-conf/config-engine";
import { additions, checkRoot } from "./root-behavior.mjs";

const require = createRequire(import.meta.url);
const baseline = require("./packaging/exports.json").filter(name => !additions.includes(name));
for (const [mode, engine] of [["ESM", esm], ["CJS", require("@weaver-conf/config-engine")]]) {
  test(`${mode} root adds exactly nine values and invokes their existing behavior`, () => {
    assert.deepEqual(Object.keys(engine).sort(), [...baseline, ...additions].sort());
    for (const name of additions) assert.equal(typeof engine[name], "function", name);
    checkRoot(engine, assert);
  });
}
