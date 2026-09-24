import assert from "node:assert/strict";
import test from "node:test";
import { type Schema, Validator } from "@cfworker/json-schema";
import Ajv from "ajv";
import { schemaValidationResultSchema } from "../../src/schema-validation-schemas.js";
import { createAjvRuntimeAdapter } from "./adapters/ajv-runtime.js";
import { createBaselineAdapter } from "./adapters/baseline.js";
import { createCfworkerAdapter } from "./adapters/cfworker.js";
import { effectiveShadow } from "./defaults-shadow.js";
import { lowerSchema } from "./lower-schema.js";
import { buildMatrix } from "./run-matrix.js";

test("shared matrix reproduces baseline and emits public result contracts", async () => {
  const matrix = await buildMatrix();
  assert.ok(matrix.fixtureCount >= 55);
  assert.equal(matrix.summary.baseline.parity, matrix.summary.baseline.total);
  for (const row of matrix.rows) {
    schemaValidationResultSchema.parse(row.expected);
    for (const cell of row.actual)
      schemaValidationResultSchema.parse(cell.normalized);
  }
});

test("effective defaults use a non-mutating shadow and partial mode does not", () => {
  const schema = {
    type: "object",
    required: ["x"],
    properties: { x: { type: "string", default: "ok" } },
  } as const;
  const value = {};
  const schemaSnapshot = JSON.stringify(schema);
  const schemaDescriptors = Object.getOwnPropertyDescriptors(schema);
  const valueDescriptors = Object.getOwnPropertyDescriptors(value);
  const shadow = effectiveShadow(schema, value);
  assert.deepEqual(shadow, { x: "ok" });
  assert.deepEqual(value, {});
  assert.equal(JSON.stringify(schema), schemaSnapshot);
  assert.deepEqual(Object.getOwnPropertyDescriptors(schema), schemaDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(value), valueDescriptors);
  assert.notEqual(shadow, value);
  assert.equal(
    createCfworkerAdapter().compile(schema, "partial").validate(value)
      .normalized.valid,
    true,
  );
  assert.equal(
    createAjvRuntimeAdapter().compile(schema, "partial").validate(value)
      .normalized.valid,
    true,
  );
});

test("lowering preserves additionalProperties forms and closed-object parity", () => {
  const closed = { type: "object", additionalProperties: false } as const;
  assert.equal(lowerSchema(closed, "partial").additionalProperties, false);
  for (const adapter of [
    createBaselineAdapter(),
    createCfworkerAdapter(),
    createAjvRuntimeAdapter(),
  ]) {
    const result = adapter.compile(closed, "partial").validate({ own: 1 });
    assert.equal(result.normalized.valid, false, adapter.id);
    assert.equal(
      result.normalized.errors[0]?.code,
      "unknown-property",
      adapter.id,
    );
  }
});

test("own undefined members receive effective defaults without mutation", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string", default: "ok" } },
  } as const;
  const value = { x: undefined };
  const identity = value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.deepEqual(effectiveShadow(schema, value), { x: "ok" });
  assert.equal(value, identity);
  assert.equal(value.x, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors);
  for (const adapter of [
    createBaselineAdapter(),
    createCfworkerAdapter(),
    createAjvRuntimeAdapter(),
  ]) {
    assert.equal(
      adapter.compile(schema, "effective").validate(value).normalized.valid,
      true,
      adapter.id,
    );
    adapter.compile(schema, "partial").validate(value);
    assert.equal(value.x, undefined, adapter.id);
    assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors);
  }
});

test("candidate raw composition capability is separate from Weaver admission", () => {
  const schema: Schema = { oneOf: [{ type: "string" }, { type: "number" }] };
  assert.equal(new Validator(schema).validate("x").valid, true);
  assert.equal(new Ajv({ strict: false }).validate(schema, "x"), true);
});

test("candidate options do not mutate valid or invalid input", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "integer", default: 1 } },
  } as const;
  for (const adapter of [createCfworkerAdapter(), createAjvRuntimeAdapter()]) {
    for (const value of [{}, { x: "bad" }]) {
      const before = JSON.stringify(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      adapter.compile(schema, "partial").validate(value);
      assert.equal(JSON.stringify(value), before);
      assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors);
      assert.equal(Object.hasOwn(value, "x"), value.x !== undefined);
    }
  }
});

test("own collision keys remain data properties without prototype mutation", () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const value = JSON.parse(
    '{"__proto__":"ok","constructor":"ok","prototype":"ok","toString":"ok"}',
  );
  const schema = {
    type: "object",
    additionalProperties: { type: "string" },
  } as const;
  try {
    for (const adapter of [
      createCfworkerAdapter(),
      createAjvRuntimeAdapter(),
    ]) {
      assert.equal(
        adapter.compile(schema, "partial").validate(value).normalized.valid,
        true,
      );
    }
  } finally {
    assert.deepEqual(
      Object.getOwnPropertyDescriptors(Object.prototype),
      before,
    );
  }
  assert.equal(Object.hasOwn(value, "__proto__"), true);
});

test("inherited schema and value getters are not invoked", () => {
  let calls = 0;
  const prototype = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(prototype, "inherited", {
    get: () => {
      calls++;
      return { type: "string" };
    },
  });
  const properties = Object.create(prototype) as Record<
    string,
    { readonly type: "string" }
  >;
  const value = Object.create(
    Object.defineProperty({}, "inherited", {
      get: () => {
        calls++;
        return "bad";
      },
    }),
  ) as Record<string, unknown>;
  const schema = { type: "object", properties } as const;
  for (const adapter of [createCfworkerAdapter(), createAjvRuntimeAdapter()]) {
    assert.equal(
      adapter.compile(schema, "partial").validate(value).normalized.valid,
      true,
    );
  }
  assert.equal(calls, 0);
});
