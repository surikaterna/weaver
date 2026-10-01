import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { loadPrivateSafetyModules, probeCanonicalRoots, underNumericTrap } from "./validator-own-data-helper.mjs";

const modules = await loadPrivateSafetyModules();
const childMode = process.env.WEAVER_VALIDATOR_SCRATCH_CHILD;

function denseValues(length) {
  const values = [];
  for (let index = 0; index < length; index++) {
    Object.defineProperty(values, String(index), {
      value: index, configurable: true, enumerable: true, writable: true,
    });
  }
  return values;
}

function schemaFixture() {
  const properties = {};
  for (let index = 0; index < 702; index++) {
    Object.defineProperty(properties, `p${index}`, {
      value: { type: "number", default: index },
      configurable: true, enumerable: true, writable: true,
    });
  }
  return { type: "object", properties };
}

function exerciseSafeScratch(prototype, index) {
  const schema = schemaFixture();
  const left = denseValues(702);
  const right = denseValues(702);
  const leftRecord = Object.fromEntries(left.map((value) => [`p${value}`, { value }]));
  const rightRecord = Object.fromEntries(right.map((value) => [`p${value}`, { value }]));
  const path = left.map((value) => `p${value}`).join(".");
  const outcome = underNumericTrap(prototype, index, () => {
    const snapshot = modules.captureSchemaStability(schema);
    return {
      reusable: snapshot.reusable,
      stable: modules.schemaStabilityMatches(snapshot),
      equal: modules.deepEqual(left, right),
      equalRecords: modules.deepEqual(leftRecord, rightRecord),
      parsed: modules.parsePath(path),
    };
  });
  assert.equal(outcome.getters, 0);
  assert.equal(outcome.setters, 0);
  assert.equal(outcome.value.reusable, true);
  assert.equal(outcome.value.stable, true);
  assert.equal(outcome.value.equal, true);
  assert.equal(outcome.value.equalRecords, true);
  assert.equal(outcome.value.parsed.length, 702);
  assert.equal(outcome.value.parsed[700], "p700");
}

function exerciseNegativeControls(prototype, index) {
  const scratch = denseValues(index);
  const sparse = [];
  sparse.length = index + 1;
  const outcome = underNumericTrap(prototype, index, () => {
    scratch.push("unsafe");
    return sparse[index];
  });
  assert.equal(outcome.getters, 1, "missing tuple slot must trigger the getter control");
  assert.equal(outcome.setters, 1, "native push must trigger the setter control");
}

if (process.argv.includes("--probe")) {
  if (!await probeCanonicalRoots()) process.exitCode = 1;
} else if (childMode !== undefined) {
  const [prototypeName, indexText] = childMode.split(":");
  const prototype = prototypeName === "object" ? Object.prototype : Array.prototype;
  const index = Number(indexText);
  exerciseNegativeControls(prototype, index);
  exerciseSafeScratch(prototype, index);
} else {
  for (const prototype of ["object", "array"]) {
    for (const index of [0, 1, 700]) {
      test(`owned stability/equality/parser scratch: ${prototype} numeric ${index}, with unsafe controls`, () => {
        const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
          env: { ...process.env, WEAVER_VALIDATOR_SCRATCH_CHILD: `${prototype}:${index}` },
          encoding: "utf8", timeout: 30_000,
        });
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      });
    }
  }

  test("stability keeps schema references and invalidates observable descriptor/container mutations", () => {
    const shared = { type: "number", default: 1, const: 1, enum: [1] };
    const schema = { type: "object", properties: { a: shared, b: shared } };
    const snapshot = modules.captureSchemaStability(schema);
    assert.equal(snapshot.reusable, true);
    assert.equal(snapshot.objects.some(({ target }) => target === shared), true);
    assert.equal(modules.schemaStabilityMatches(snapshot), true);
    const mutations = [
      () => { shared.default = 2; },
      () => { shared.const = 2; },
      () => { shared.enum[0] = 2; },
      () => { schema.properties.a = { type: "string" }; },
      () => { Object.defineProperty(shared, "type", { enumerable: false }); },
      () => { Object.setPrototypeOf(shared, null); },
      () => { Object.preventExtensions(shared); },
    ];
    for (const mutate of mutations) {
      const before = modules.captureSchemaStability(schema);
      assert.equal(before.reusable, true);
      mutate();
      assert.equal(modules.schemaStabilityMatches(before), false);
      assert.equal(modules.schemaStabilityMatches(modules.captureSchemaStability(schema)), true);
    }
  });

  test("stability refuses own accessors without execution; parser syntax and sparse equality are unchanged", () => {
    let getters = 0;
    const schema = { type: "number" };
    const snapshot = modules.captureSchemaStability(schema);
    Object.defineProperty(schema, "default", { get() { getters++; return 1; } });
    assert.equal(modules.schemaStabilityMatches(snapshot), false);
    assert.equal(modules.captureSchemaStability(schema).reusable, false);
    assert.equal(getters, 0);
    assert.deepEqual(modules.parsePath("a[0].[literal.dot].😀"), ["a", "0", "literal.dot", "😀"]);
    assert.throws(() => modules.parsePath("a..b"));
    assert.throws(() => modules.parsePath("a.constructor"));
    assert.equal(modules.deepEqual(Array(2), Array(2)), true);
    assert.equal(modules.deepEqual(Array(2), [undefined, undefined]), false);
  });
}
