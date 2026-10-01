import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as engine from "../dist/index.js";
import { checkCompactSnapshots } from "./compact-behavior.mjs";

test("built root supports iterative deep/context-aware DAG snapshots", () => checkCompactSnapshots(engine, assert));
test("fresh source graph/context counters prove compact resolution and on-demand inspection", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./compact-source.mjs", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(result.stdout);
});
