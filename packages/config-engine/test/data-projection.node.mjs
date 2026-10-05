import assert from "node:assert/strict";
import { test } from "node:test";
import { createMountSourceClassifier, projectConfigurationData, isProtectedConfigPath } from "../dist/index.js";

test("iterative projection is deep-safe and visits shared value/context pairs once", () => {
  const context = {};
  let visits = 0;
  const visitor = { decide: () => { visits++; return "descend"; }, child: () => context };
  let deep = "leaf";
  for (let index = 0; index < 20000; index++) deep = { child: deep };
  const output = projectConfigurationData(deep, context, visitor);
  assert.equal(visits, 20001);
  let current = output;
  for (let index = 0; index < 20000; index++) { assert.ok(Object.isFrozen(current)); current = current.child; }
  assert.equal(current, "leaf");
  let shared = { value: "leaf" };
  for (let index = 0; index < 100; index++) shared = { left: shared, right: shared };
  visits = 0;
  const dag = projectConfigurationData(shared, context, visitor);
  assert.equal(visits, 102);
  assert.equal(dag.left, dag.right);
  assert.notEqual(dag, shared);
});

test("descriptor admission rejects accessors/cycles/symbols before callbacks", () => {
  let getters = 0, callbacks = 0;
  const visitor = { decide: () => { callbacks++; return "descend"; }, child: context => context };
  const accessor = { get value() { getters++; return "secret"; } };
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [accessor, cyclic, { [Symbol("data")]: true }, Object.create({ inherited: true })])
    assert.throws(() => projectConfigurationData(value, {}, visitor), { code: "VALIDATION_ERROR" });
  assert.equal(getters, 0); assert.equal(callbacks, 0);
  const result = projectConfigurationData({ public: ["value"], _weaver: "literal" }, {}, visitor);
  assert.equal(getters, 0);
  assert.deepEqual(result, { public: ["value"], _weaver: "literal" });
});

test("shared mount classification keeps legacy cycles public and restrictive cycles denied", () => {
  const state = { a: { _weaver: "mount", source: "b" }, b: { _weaver: "mount", source: "a" },
    protected: { _weaver: "mount", source: "_weaver.providers" }, safe: "ordinary" };
  for (const cycles of [false, true]) {
    const classifier = createMountSourceClassifier(state, path => path[0] === "denied", cycles);
    assert.equal(classifier.isTainted(state.a), cycles);
    assert.equal(classifier.isTainted(state.protected), true);
    assert.equal(classifier.isTainted({ _weaver: "mount", source: "safe" }), false);
  }
  for (const key of ["_weaver", "/_weaver/data", "[_weaver].data", "_weaver[broken"])
    assert.equal(isProtectedConfigPath(key), true);
  assert.equal(isProtectedConfigPath("ordinary._weaver"), false);
});
