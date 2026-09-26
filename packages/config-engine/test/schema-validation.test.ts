import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { deepEqual } from "../src/deep-equal.js";
import {
  validateConfigurationPatch,
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "../src/schema-validation.js";
import { schemaValidationResultSchema } from "../src/schema-validation-schemas.js";

const settingsSchema: ConfigurationPropertySchema = {
  type: "object",
  required: ["mode", "endpoint"],
  properties: {
    mode: { type: "string", enum: ["dev", "prod"], default: "dev" },
    endpoint: { type: "string", minLength: 1 },
    flags: {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        rollout: { type: "number", minimum: 0, maximum: 100 },
      },
      additionalProperties: false,
    },
    ports: { type: "array", items: { type: "integer", minimum: 1 } },
  },
};

const prototypeCollisionKeys = [
  "toString",
  "valueOf",
  "hasOwnProperty",
  "constructor",
] as const;
const patchCollisionKeys = ["toString", "valueOf", "hasOwnProperty"] as const;

function expectPublicResultCompatible(result: unknown): void {
  expect(() => schemaValidationResultSchema.parse(result)).not.toThrow();
}

function deepFixture(
  depth: number,
  leaf: unknown,
): {
  readonly schema: ConfigurationPropertySchema;
  readonly value: unknown;
  readonly path: readonly string[];
} {
  let schema: ConfigurationPropertySchema = { type: "string" };
  let value = leaf;
  const path: string[] = [];
  for (let index = 0; index < depth; index++) {
    schema = {
      type: "object",
      properties: { next: schema },
      additionalProperties: false,
    };
    value = { next: value };
    path.push("next");
  }
  path.reverse();
  return { schema, value, path };
}

function cyclicObject(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

describe("schema validation", () => {
  it("rejects invalid types with path-aware errors", () => {
    const result = validatePartialConfiguration(settingsSchema, {
      flags: { enabled: "yes" },
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-type",
      path: "$.flags.enabled",
      segments: ["flags", "enabled"],
    });
  });

  it("rejects unknown properties when additionalProperties is absent", () => {
    const result = validatePartialConfiguration(settingsSchema, {
      surprise: true,
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "unknown-property",
      path: "$.surprise",
    });
  });

  it("rejects unknown nested properties when additionalProperties is false", () => {
    const result = validatePartialConfiguration(settingsSchema, {
      flags: { enabled: true, extra: "blocked" },
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "unknown-property",
      path: "$.flags.extra",
    });
  });

  it("validates prototype-colliding keys as open additional properties", () => {
    const value = Object.fromEntries(
      prototypeCollisionKeys.map((key) => [key, "allowed"]),
    );
    const typedSchema: ConfigurationPropertySchema = {
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    };
    const schemas: ConfigurationPropertySchema[] = [
      { type: "object", properties: {}, additionalProperties: true },
      typedSchema,
    ];

    for (const schema of schemas) {
      expect(validatePartialConfiguration(schema, value)).toEqual({
        valid: true,
        errors: [],
      });
      expect(validateEffectiveConfiguration(schema, value)).toEqual({
        valid: true,
        errors: [],
      });
      for (const key of patchCollisionKeys) {
        expect(validateConfigurationPatch(schema, key, "allowed")).toEqual({
          valid: true,
          errors: [],
        });
      }
    }
    expect(
      validateConfigurationPatch(typedSchema, "toString", 1).errors[0],
    ).toMatchObject({ code: "invalid-type", expected: "string" });
  });

  it("reports prototype-colliding keys as unknown under closed schemas", () => {
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    const value = Object.fromEntries(
      prototypeCollisionKeys.map((key) => [key, "blocked"]),
    );

    for (const result of [
      validatePartialConfiguration(schema, value),
      validateEffectiveConfiguration(schema, value),
    ]) {
      expect(result.errors).toHaveLength(prototypeCollisionKeys.length);
      expect(
        result.errors.every((error) => error.code === "unknown-property"),
      ).toBe(true);
    }
    for (const key of patchCollisionKeys) {
      const result = validateConfigurationPatch(schema, key, "blocked");
      expect(result.errors[0]).toMatchObject({
        code: "unknown-property",
        segments: [key],
      });
    }
  });

  it("validates explicitly declared own prototype-colliding properties", () => {
    const properties = Object.fromEntries(
      prototypeCollisionKeys.map(
        (key): [string, ConfigurationPropertySchema] => [
          key,
          { type: "string" },
        ],
      ),
    );
    properties.toString = { type: "string", default: "declared" };
    const schema: ConfigurationPropertySchema = {
      type: "object",
      required: ["toString"],
      properties,
      additionalProperties: false,
    };
    const value = Object.fromEntries(
      prototypeCollisionKeys.map((key) => [key, "declared"]),
    );

    expect(validatePartialConfiguration(schema, value)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateEffectiveConfiguration(schema, {})).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateConfigurationPatch(schema, "toString", 1).errors[0],
    ).toMatchObject({
      code: "invalid-type",
      path: "$.toString",
    });
  });

  it("does not invoke getters for inherited property schemas", () => {
    let getterCalls = 0;
    const properties: Record<string, ConfigurationPropertySchema> = new Proxy(
      {},
      {
        get() {
          getterCalls += 1;
          return { type: "number" };
        },
      },
    );
    const schema: ConfigurationPropertySchema = {
      type: "object",
      required: ["toString"],
      properties,
      additionalProperties: true,
    };

    expect(
      validatePartialConfiguration(
        schema,
        Object.fromEntries([["toString", "allowed"]]),
      ),
    ).toEqual({ valid: true, errors: [] });
    expect(validateConfigurationPatch(schema, "toString", "allowed")).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateEffectiveConfiguration(schema, {}).errors[0]).toMatchObject({
      code: "missing-required",
      path: "$.toString",
    });
    expect(getterCalls).toBe(0);
  });

  it("rejects enum values outside the schema", () => {
    const result = validatePartialConfiguration(settingsSchema, { mode: "qa" });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-value",
      path: "$.mode",
    });
  });

  it("rejects bad nested object shapes", () => {
    const result = validatePartialConfiguration(settingsSchema, {
      flags: { rollout: -1 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-value",
      path: "$.flags.rollout",
    });
  });

  it("validates arrays and member patches against item schemas", () => {
    const writeResult = validatePartialConfiguration(settingsSchema, {
      ports: [8080, "bad"],
    });
    const patchResult = validateConfigurationPatch(
      settingsSchema,
      ["ports", 0],
      "bad",
    );

    expect(writeResult.valid).toBe(false);
    expect(writeResult.errors[0]).toMatchObject({
      code: "invalid-type",
      path: "$.ports[1]",
    });
    expect(patchResult.valid).toBe(false);
    expect(patchResult.errors[0]).toMatchObject({
      code: "invalid-type",
      path: "$.ports[0]",
    });
  });

  it("allows partial writes that omit required fields", () => {
    const result = validatePartialConfiguration(settingsSchema, {
      flags: { rollout: 25 },
    });

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("enforces required fields during effective validation", () => {
    const result = validateEffectiveConfiguration(settingsSchema, {
      mode: "prod",
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "missing-required",
      path: "$.endpoint",
    });
  });

  it("allows schema defaults and effective context to satisfy required fields", () => {
    const result = validateEffectiveConfiguration(settingsSchema, {
      endpoint: "https://api.example.test",
    });

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("validates property patch paths and nested patch values", () => {
    const result = validateConfigurationPatch(settingsSchema, "flags", {
      enabled: "yes",
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-type",
      path: "$.flags.enabled",
      segments: ["flags", "enabled"],
    });
  });

  it.each([
    {
      name: "empty string patch path",
      run: () => validateConfigurationPatch(settingsSchema, "", true),
      path: "$",
    },
    {
      name: "malformed string patch path",
      run: () =>
        validateConfigurationPatch(settingsSchema, "flags..enabled", true),
      path: "$",
    },
    {
      name: "malformed string options path",
      run: () =>
        validateConfigurationPatch(settingsSchema, "enabled", true, {
          path: "flags.",
        }),
      path: "$",
    },
    {
      name: "infinite patch array segment",
      run: () => validateConfigurationPatch(settingsSchema, [Infinity], "x"),
      path: "$",
    },
    {
      name: "NaN patch array segment",
      run: () => validateConfigurationPatch(settingsSchema, [Number.NaN], "x"),
      path: "$",
    },
    {
      name: "infinite patch array segment after valid prefix",
      run: () =>
        validateConfigurationPatch(settingsSchema, ["ports", Infinity], "x"),
      path: "$.ports",
    },
    {
      name: "infinite options array segment",
      run: () =>
        validateConfigurationPatch(settingsSchema, "enabled", true, {
          path: [Infinity],
        }),
      path: "$",
    },
    {
      name: "NaN options array segment",
      run: () =>
        validateConfigurationPatch(settingsSchema, "enabled", true, {
          path: [Number.NaN],
        }),
      path: "$",
    },
    {
      name: "NaN options array segment after valid prefix",
      run: () =>
        validateConfigurationPatch(settingsSchema, "enabled", true, {
          path: ["flags", Number.NaN],
        }),
      path: "$.flags",
    },
    {
      name: "negative array index",
      run: () => validateConfigurationPatch(settingsSchema, ["ports", -1], 1),
      path: "$.ports[-1]",
    },
    {
      name: "member path on scalar schema",
      run: () =>
        validateConfigurationPatch(settingsSchema, ["mode", "nested"], true),
      path: "$.mode.nested",
    },
  ])("emits result-schema-compatible invalid-path result for $name", ({
    run,
    path,
  }) => {
    const result = run();

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ code: "invalid-path", path });
    expectPublicResultCompatible(result);
  });

  it("validates patches against all matching pattern properties", () => {
    const schema: ConfigurationPropertySchema = {
      type: "object",
      patternProperties: {
        "^feature-": { type: "string", minLength: 1 },
        flag$: { type: "string", enum: ["enabled"] },
      },
      additionalProperties: false,
    };

    const result = validateConfigurationPatch(
      schema,
      "feature-flag",
      "disabled",
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "invalid-value",
        path: "$.feature-flag",
      }),
    );
  });

  it("validates patches against declared and pattern member schemas", () => {
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["prod"] },
      },
      patternProperties: {
        "^mode$": { type: "string", minLength: 5 },
      },
      additionalProperties: false,
    };

    const result = validateConfigurationPatch(schema, "mode", "prod");

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "invalid-value",
        path: "$.mode",
      }),
    );
  });

  it("supports composition schemas during value validation", () => {
    const schema: ConfigurationPropertySchema = {
      type: "string",
      anyOf: [{ type: "string", const: "ok" }],
      oneOf: [{ type: "string", minLength: 1 }],
      allOf: [{ type: "string", maxLength: 2 }],
      not: { type: "string", const: "blocked" },
    };

    expect(validatePartialConfiguration(schema, "ok")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("fully validates composition on a resolved patch leaf", () => {
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: {
        x: {
          type: "string",
          anyOf: [{ type: "string", const: "ok" }],
        },
      },
      additionalProperties: false,
    };

    const result = validateConfigurationPatch(schema, "x", "blocked");
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "invalid-value",
        path: "$.x",
        message: "Value must match at least one anyOf branch",
      }),
    ]);
    expectPublicResultCompatible(result);
  });

  it("defers contextual ancestors while projecting allOf patch constraints", () => {
    const schema: ConfigurationPropertySchema = {
      type: "object",
      additionalProperties: true,
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "number" } },
          additionalProperties: true,
        },
      ],
      allOf: [
        {
          type: "object",
          properties: { x: { type: "string" } },
          additionalProperties: true,
        },
      ],
    };

    const result = validateConfigurationPatch(schema, "x", 1);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-type",
      path: "$.x",
      expected: "string",
    });
    expectPublicResultCompatible(result);
  });

  it("validates depth-5000 values and patches without recursive overflow", () => {
    const valid = deepFixture(5_000, "ok");
    const invalid = deepFixture(5_000, 1);

    const results = [
      validatePartialConfiguration(valid.schema, valid.value),
      validateEffectiveConfiguration(valid.schema, valid.value),
      validatePartialConfiguration(invalid.schema, invalid.value),
      validateEffectiveConfiguration(invalid.schema, invalid.value),
      validateConfigurationPatch(valid.schema, valid.path, "ok"),
      validateConfigurationPatch(valid.schema, valid.path, 1),
    ];

    expect(results.map((result) => result.valid)).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(results[2]?.errors[0]?.segments).toEqual(invalid.path);
    expect(results[3]?.errors[0]?.segments).toEqual(invalid.path);
    expect(results[5]?.errors[0]?.segments).toEqual(valid.path);
    results.forEach(expectPublicResultCompatible);
  });

  it("returns typed errors for cyclic schemas and schema constraints", () => {
    const cyclicSchema: ConfigurationPropertySchema = { type: "object" };
    cyclicSchema.properties = { self: cyclicSchema };
    const cyclicConstraint = cyclicObject();
    const cyclicEnum: unknown[] = [];
    cyclicEnum.push(cyclicEnum);
    const schemas: ConfigurationPropertySchema[] = [
      cyclicSchema,
      { type: "object", default: cyclicConstraint },
      { type: "object", const: cyclicConstraint },
      { type: "object", enum: cyclicEnum },
    ];

    for (const schema of schemas) {
      const result = validatePartialConfiguration(schema, {});
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "invalid-schema", path: "$" }),
      ]);
      expectPublicResultCompatible(result);
    }
  });

  it("rejects value cycles, including unconstrained branches", () => {
    const direct = cyclicObject();
    const hidden = cyclicObject();
    const schema: ConfigurationPropertySchema = {
      type: "object",
      additionalProperties: true,
    };

    const directResult = validatePartialConfiguration(schema, direct);
    const hiddenResult = validateEffectiveConfiguration(schema, { hidden });

    expect(directResult.errors[0]).toMatchObject({
      code: "invalid-value",
      path: "$.self",
    });
    expect(hiddenResult.errors[0]).toMatchObject({
      code: "invalid-value",
      path: "$.hidden.self",
    });
    expectPublicResultCompatible(directResult);
    expectPublicResultCompatible(hiddenResult);
  });

  it("allows shared acyclic schema and value references", () => {
    const memberSchema: ConfigurationPropertySchema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: { left: memberSchema, right: memberSchema },
      additionalProperties: false,
    };
    const shared = { name: "same" };

    expect(
      validatePartialConfiguration(schema, { left: shared, right: shared }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("deep equality terminates for deep and cyclic pairs", () => {
    const left = deepFixture(5_000, "same").value;
    const right = deepFixture(5_000, "same").value;
    const leftCycle = cyclicObject();
    const rightCycle = cyclicObject();

    expect(deepEqual(left, right)).toBe(true);
    expect(deepEqual(leftCycle, rightCycle)).toBe(true);
    rightCycle.different = true;
    expect(deepEqual(leftCycle, rightCycle)).toBe(false);
  });

  it.each([
    { name: "homogeneous partial", effective: false, tuple: false },
    { name: "homogeneous effective", effective: true, tuple: false },
    { name: "tuple partial", effective: false, tuple: true },
    { name: "tuple effective", effective: true, tuple: true },
  ])("rejects sparse arrays in $name mode", ({ effective, tuple }) => {
    const value = new Array<unknown>(2);
    value[1] = "ok";
    const schema: ConfigurationPropertySchema = {
      type: "array",
      items: tuple
        ? [{ type: "string" }, { type: "string" }]
        : { type: "string" },
    };
    const result = effective
      ? validateEffectiveConfiguration(schema, value)
      : validatePartialConfiguration(schema, value);

    expect(result.errors[0]).toMatchObject({
      code: "invalid-value",
      path: "$[0]",
      segments: [0],
    });
    expectPublicResultCompatible(result);
  });

  it("accepts dense arrays and canonical array member indexes", () => {
    const schema: ConfigurationPropertySchema = {
      type: "array",
      items: { type: "string" },
    };

    expect(validatePartialConfiguration(schema, ["a", "b"])).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateConfigurationPatch(schema, "0", "ok").valid).toBe(true);
    expect(
      validateConfigurationPatch(schema, [4_294_967_294], "ok").valid,
    ).toBe(true);
  });

  it.each([
    "00",
    "+1",
    "1e0",
    "1.0",
    "-0",
    4_294_967_295,
    -0,
  ])("rejects noncanonical array member index %s", (index) => {
    const result = validateConfigurationPatch(
      { type: "array", items: { type: "string" } },
      [index],
      "ok",
    );

    expect(result.errors[0]).toMatchObject({ code: "invalid-path" });
    expectPublicResultCompatible(result);
  });

  it.each([
    { value: "a", minLength: 1, maxLength: 1, valid: true },
    { value: "😀", minLength: 1, maxLength: 1, valid: true },
    { value: "😀a", maxLength: 1, valid: false, count: 2 },
    { value: "e\u0301", maxLength: 1, valid: false, count: 2 },
    { value: "😀", minLength: 2, valid: false, count: 1 },
  ])("counts Unicode code points in string bounds", (testCase) => {
    const result = validatePartialConfiguration(
      {
        type: "string",
        minLength: testCase.minLength,
        maxLength: testCase.maxLength,
      },
      testCase.value,
    );

    expect(result.valid).toBe(testCase.valid);
    if (!testCase.valid) {
      expect(result.errors[0]?.message).toContain(String(testCase.count));
    }
    expectPublicResultCompatible(result);
  });

  it.each([
    { value: 0.3, multipleOf: 0.1, valid: true },
    { value: -0.3, multipleOf: 0.1, valid: true },
    { value: 0, multipleOf: 0.1, valid: true },
    { value: 1.2, multipleOf: 0.03, valid: true },
    { value: 3e-7, multipleOf: 1e-7, valid: true },
    { value: 3e21, multipleOf: 1e21, valid: true },
    { value: 0.31, multipleOf: 0.1, valid: false },
    { value: 0.30000000000000004, multipleOf: 0.1, valid: false },
  ])("uses exact decimal arithmetic for multipleOf", (testCase) => {
    const result = validatePartialConfiguration(
      { type: "number", multipleOf: testCase.multipleOf },
      testCase.value,
    );

    expect(result.valid).toBe(testCase.valid);
    expectPublicResultCompatible(result);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid multipleOf divisor %s as invalid-schema", (multipleOf) => {
    const result = validatePartialConfiguration(
      { type: "number", multipleOf },
      1,
    );

    expect(result.errors[0]).toMatchObject({ code: "invalid-schema" });
    expectPublicResultCompatible(result);
  });
});
