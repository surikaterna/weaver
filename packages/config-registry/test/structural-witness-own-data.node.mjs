import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ownDataExercise, pathBoundaryExercise } from "./structural-witness-own-data-helper.mjs";

test("W1-W9 isolated own-data matrix: numeric scratch, missing slots, inherited fields, real branches and accessor preflight", () => {
  const registry = new URL("../dist/index.js", import.meta.url).href;
  const engine = new URL("../../config-engine/dist/index.js", import.meta.url).href;
  const source = `import * as support from ${JSON.stringify(registry)};
    import * as engine from ${JSON.stringify(engine)}; ${ownDataExercise}`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.match(output, /getterCalls: 0/);
  console.log(output);
});

test("every own path slot must be a string before inherited or own coercion", () => {
  const registry = new URL("../dist/index.js", import.meta.url).href;
  const source = `import * as support from ${JSON.stringify(registry)}; ${pathBoundaryExercise}`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.match(output, /coercionGetters: 0/);
  assert.match(output, /coercionCallbacks: 0/);
  console.log(output);
});

test("private utility owns scratch and descriptor reads; no public helper exports", async () => {
  const source = await readFile(new URL("../src/structural-witness-own-data.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.push\(|Object\.entries\(|\bany\b|\bas\s+(?:const|\w+)/);
  assert.match(source, /Object\.defineProperty\(values, ownLength\(values\), \{/);
  assert.match(source, /Object\.hasOwn\(descriptor, "value"\)/);
  const root = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(root, /structural-witness-own-data/);
});
