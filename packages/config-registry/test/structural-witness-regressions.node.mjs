import assert from "node:assert/strict";
import { test } from "node:test";
import * as support from "../dist/index.js";
import * as engine from "@weaver-conf/config-engine";
import { exerciseWitness, exerciseWitnessPaths } from "./structural-witness-regressions.mjs";

test("witness declaration, composition, cycles and descriptor-first input admission", () => {
  assert.deepEqual(exerciseWitness(support, engine), { semanticCases: 20, ownGetterCalls: 0 });
});
test("every own path slot rejects before coercion and missing tuple slots stay undeclared", () => {
  assert.deepEqual(exerciseWitnessPaths(support), { rejectedCases: 32, coercionGetters: 0, coercionCallbacks: 0 });
});
