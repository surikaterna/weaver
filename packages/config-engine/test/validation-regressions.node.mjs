import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import * as engine from "../dist/index.js";
import { createConfigurationValidationSession } from "../dist/schema-validation-session.js";
import { exerciseValidation, exerciseValidationCache } from "./validation-regressions.mjs";

test("public validation preserves composition, constraints, paths and caller-data admission", () => {
  assert.deepEqual(exerciseValidation(engine), { ordinaryCases: 48, callerGetterCalls: 0 });
});
test("call-local sessions invalidate explicit schema, descriptor, container and literal mutations", () => {
  exerciseValidationCache(engine, createConfigurationValidationSession);
});
test("stability observes original identities, descriptors, prototypes and extensibility", () => {
  execFileSync(process.execPath, ["--import", "tsx", new URL("./schema-stability-source.mjs", import.meta.url).pathname]);
});
test("trusted schema getters remain executable, while caller values are descriptor-admitted", () => {
  let reads = 0;
  const schema = { get type() { reads++; return "boolean"; } };
  const session = createConfigurationValidationSession(schema);
  assert.equal(session.validatePartial(true).valid, true);
  assert.equal(session.validatePartial("wrong").valid, false);
  assert.ok(reads > 0, "schema shape is not an executable-code sandbox");
  let getters = 0;
  const value = { get flag() { getters++; return true; } };
  assert.equal(engine.validatePartialConfiguration({ type: "object" }, value).errors[0].code, "invalid-value");
  assert.equal(getters, 0);
});
test("sparse equality and descriptor-safe comparisons preserve literal distinctions", () => {
  assert.equal(engine.deepEqual(Array(2), Array(2)), true);
  assert.equal(engine.deepEqual(Array(2), [undefined, undefined]), false);
  let getters = 0;
  const value = { get flag() { getters++; return true; } };
  assert.equal(engine.deepEqual(value, { flag: true }), false);
  assert.equal(getters, 0);
});
