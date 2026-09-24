import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "../src/schema-validation.js";
import { schemaValidationResultSchema } from "../src/schema-validation-schemas.js";

const keywordCases = ["anyOf", "oneOf", "allOf"] as const;

function setRuntimeField(
  schema: ConfigurationPropertySchema,
  key: PropertyKey,
  value: unknown,
): void {
  Reflect.defineProperty(schema, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function runtimeSchema(
  type: ConfigurationPropertySchema["type"],
  key: PropertyKey,
  value: unknown,
): ConfigurationPropertySchema {
  const schema: ConfigurationPropertySchema = { type };
  setRuntimeField(schema, key, value);
  return schema;
}

function expectStructuralSchemaError(
  schema: ConfigurationPropertySchema,
  value: unknown,
  message: string,
): void {
  const validate = () =>
    validatePartialConfiguration(schema, value, { path: ["base", 2] });
  expect(validate).not.toThrow();
  const result = validate();
  expect(result).toEqual({
    valid: false,
    errors: [
      {
        code: "invalid-schema",
        path: "$.base[2]",
        segments: ["base", 2],
        message,
      },
    ],
  });
  expect(schemaValidationResultSchema.safeParse(result).success).toBe(true);
}

function compositionCycle(
  keyword: (typeof keywordCases)[number] | "not",
): ConfigurationPropertySchema {
  const schema: ConfigurationPropertySchema = { type: "string" };
  if (keyword === "not") schema.not = schema;
  else schema[keyword] = [schema];
  return schema;
}

function nestedComposition(
  depth: number,
  leaf: ConfigurationPropertySchema,
): ConfigurationPropertySchema {
  let schema = leaf;
  for (let index = 0; index < depth; index++) {
    schema = { type: "string", anyOf: [schema] };
  }
  return schema;
}

function mixedFixture(depth: number): {
  readonly schema: ConfigurationPropertySchema;
  readonly value: unknown;
} {
  let schema: ConfigurationPropertySchema = { type: "string", const: "ok" };
  let value: unknown = "ok";
  for (let index = 0; index < depth; index++) {
    if (index % 2 === 0) {
      schema = {
        type: ["string", "object"],
        allOf: [schema],
        additionalProperties: true,
      };
    } else {
      schema = {
        type: "object",
        properties: { next: schema },
        additionalProperties: false,
      };
      value = { next: value };
    }
  }
  return { schema, value };
}

function deepObject(depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let index = 0; index < depth; index++) value = { next: value };
  return value;
}

describe("composition schema preflight", () => {
  it("rejects malformed raw structural children before value traversal", () => {
    const branch = runtimeSchema("object", "properties", { x: null });
    const cases: readonly (readonly [
      ConfigurationPropertySchema,
      unknown,
      string,
    ])[] = [
      [
        runtimeSchema("object", "properties", { x: null }),
        { x: 1 },
        'properties entry "x" must be a schema object with a supported non-empty type',
      ],
      [
        runtimeSchema("object", "patternProperties", { "^x$": null }),
        { x: 1 },
        'patternProperties entry "^x$" must be a schema object with a supported non-empty type',
      ],
      [
        runtimeSchema("object", "additionalProperties", null),
        { extra: 1 },
        "additionalProperties must be a boolean or schema object with a supported non-empty type",
      ],
      [
        runtimeSchema("array", "items", null),
        [1],
        "items must be a schema object or dense array of schema objects with supported non-empty types",
      ],
      [
        runtimeSchema("array", "items", [null]),
        [1],
        "items entry 0 must be a schema object with a supported non-empty type",
      ],
      [
        { type: "string", anyOf: [branch] },
        "branch-type-mismatch",
        'properties entry "x" must be a schema object with a supported non-empty type',
      ],
    ];

    for (const [schema, value, message] of cases) {
      expectStructuralSchemaError(schema, value, message);
    }
  });

  it("preserves node-local and depth-first schema error order", () => {
    const malformedShape = runtimeSchema("object", "properties", { x: null });
    setRuntimeField(malformedShape, "anyOf", null);
    expectStructuralSchemaError(
      malformedShape,
      { x: 1 },
      "anyOf must be a non-empty dense array of schema objects",
    );

    const nestedFirst = runtimeSchema("array", "items", [null]);
    const ordered = runtimeSchema("object", "properties", {
      first: nestedFirst,
      second: null,
    });
    setRuntimeField(ordered, "patternProperties", { ".*": null });
    setRuntimeField(ordered, "additionalProperties", null);
    setRuntimeField(ordered, "items", null);
    setRuntimeField(ordered, "anyOf", [runtimeSchema("object", "items", null)]);
    expectStructuralSchemaError(
      ordered,
      {},
      "items entry 0 must be a schema object with a supported non-empty type",
    );

    const patternOrdered = runtimeSchema("object", "patternProperties", {
      first: nestedFirst,
      second: null,
    });
    expectStructuralSchemaError(
      patternOrdered,
      {},
      "items entry 0 must be a schema object with a supported non-empty type",
    );

    const compositionOrdered: ConfigurationPropertySchema = {
      type: "string",
      anyOf: [
        runtimeSchema("object", "properties", { first: null }),
        runtimeSchema("array", "items", [null]),
      ],
      oneOf: [runtimeSchema("object", "items", null)],
    };
    expectStructuralSchemaError(
      compositionOrdered,
      "mismatch",
      'properties entry "first" must be a schema object with a supported non-empty type',
    );
  });

  it.each(
    keywordCases,
  )("rejects empty and non-array %s definitions", (keyword) => {
    const empty: ConfigurationPropertySchema = {
      type: "string",
      [keyword]: [],
    };
    const malformed: ConfigurationPropertySchema = { type: "string" };
    setRuntimeField(malformed, keyword, null);

    for (const schema of [empty, malformed]) {
      const result = validatePartialConfiguration(schema, "value", {
        path: ["root"],
      });
      expect(result.errors).toEqual([
        {
          code: "invalid-schema",
          path: "$.root",
          segments: ["root"],
          message: `${keyword} must be a non-empty dense array of schema objects`,
        },
      ]);
      expect(schemaValidationResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it.each(
    keywordCases,
  )("rejects sparse and malformed %s branches", (keyword) => {
    const sparseBranches = new Array<ConfigurationPropertySchema>(1);
    const sparse: ConfigurationPropertySchema = {
      type: "string",
      [keyword]: sparseBranches,
    };
    const malformed: ConfigurationPropertySchema = { type: "string" };
    const malformedBranches: ConfigurationPropertySchema[] = [
      { type: "string" },
    ];
    Reflect.defineProperty(malformedBranches, "0", { value: null });
    setRuntimeField(malformed, keyword, malformedBranches);

    for (const schema of [sparse, malformed]) {
      expect(validatePartialConfiguration(schema, "value").errors).toEqual([
        expect.objectContaining({
          code: "invalid-schema",
          path: "$",
          message: `${keyword} branch 0 must be a schema object with a supported non-empty type`,
        }),
      ]);
    }
  });

  it("rejects malformed not and branch schemas with empty type", () => {
    const malformedNot: ConfigurationPropertySchema = { type: "string" };
    setRuntimeField(malformedNot, "not", null);
    const emptyType: ConfigurationPropertySchema = { type: "string" };
    setRuntimeField(emptyType, "anyOf", [{ type: [] }]);

    expect(
      validatePartialConfiguration(malformedNot, "value").errors[0],
    ).toEqual(
      expect.objectContaining({
        code: "invalid-schema",
        message: "not must be a schema object with a supported non-empty type",
      }),
    );
    expect(validatePartialConfiguration(emptyType, "value").errors[0]).toEqual(
      expect.objectContaining({
        code: "invalid-schema",
        message:
          "anyOf branch 0 must be a schema object with a supported non-empty type",
      }),
    );
  });

  it("reports invalid nested constraints before composition summaries", () => {
    const unsafe: ConfigurationPropertySchema = {
      type: "string",
      anyOf: [{ type: "string", pattern: "^(a+)+$" }],
    };
    const invalidRegex: ConfigurationPropertySchema = {
      type: "string",
      oneOf: [{ type: "string", pattern: "[" }],
    };
    const invalidNumber: ConfigurationPropertySchema = {
      type: "number",
      allOf: [{ type: "number", multipleOf: 0 }],
    };

    for (const [schema, message] of [
      [unsafe, "Unsafe regex pattern"],
      [invalidRegex, "Invalid regex pattern"],
      [invalidNumber, "multipleOf must be positive and finite"],
    ] as const) {
      const result = validatePartialConfiguration(schema, "instance", {
        path: ["base"],
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: "invalid-schema",
        path: "$.base",
        segments: ["base"],
      });
      expect(result.errors[0]?.message).toContain(message);
    }
  });

  it.each([
    ...keywordCases,
    "not",
  ] as const)("returns a typed cycle error through %s", (keyword) => {
    const result = validatePartialConfiguration(compositionCycle(keyword), "x");
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "invalid-schema",
        path: "$",
        message: "Schema must not contain cycles",
      }),
    ]);
  });
});

describe("composition iterative and adversarial safety", () => {
  it("validates depth-5000 composition without recursive overflow", () => {
    const schema = nestedComposition(5_000, { type: "string", const: "ok" });
    expect(validatePartialConfiguration(schema, "ok")).toEqual({
      valid: true,
      errors: [],
    });
    expect(validatePartialConfiguration(schema, "bad").errors).toEqual([
      expect.objectContaining({
        code: "invalid-value",
        message: "Value must match at least one anyOf branch",
      }),
    ]);
  });

  it("validates a depth-5000 mixed composition/property chain", () => {
    const fixture = mixedFixture(5_000);
    expect(validatePartialConfiguration(fixture.schema, fixture.value)).toEqual(
      {
        valid: true,
        errors: [],
      },
    );
  });

  it("memoizes completed shared diamond branch predicates per call", () => {
    let branch: ConfigurationPropertySchema = { type: "string", const: "ok" };
    for (let index = 0; index < 40; index++) {
      branch = { type: "string", allOf: [branch, branch] };
    }
    const schema: ConfigurationPropertySchema = {
      type: "string",
      oneOf: [branch, { type: "string", const: "other" }],
    };

    expect(validatePartialConfiguration(schema, "ok")).toEqual({
      valid: true,
      errors: [],
    });
    expect(validatePartialConfiguration(schema, "other")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("allows shared acyclic schemas and values under composition", () => {
    const sharedSchema: ConfigurationPropertySchema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };
    const schema: ConfigurationPropertySchema = {
      type: "object",
      allOf: [
        {
          type: "object",
          properties: { left: sharedSchema, right: sharedSchema },
          additionalProperties: false,
        },
      ],
      properties: { left: sharedSchema, right: sharedSchema },
      additionalProperties: false,
    };
    const sharedValue = { name: "same" };
    expect(
      validatePartialConfiguration(schema, {
        left: sharedValue,
        right: sharedValue,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects value cycles before producing composition summaries", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    const schema: ConfigurationPropertySchema = {
      type: "object",
      anyOf: [{ type: "object", additionalProperties: true }],
      additionalProperties: true,
    };
    expect(validatePartialConfiguration(schema, value).errors).toEqual([
      expect.objectContaining({
        code: "invalid-value",
        path: "$.self",
        message: "Configuration values must not contain cycles",
      }),
    ]);
  });

  it("ignores inherited composition and property getters", () => {
    let calls = 0;
    const prototype = {
      get anyOf() {
        calls++;
        return [{ type: "number" }];
      },
      get properties() {
        calls++;
        return { inherited: { type: "number" } };
      },
    };
    const schema: ConfigurationPropertySchema = {
      type: "object",
      additionalProperties: true,
    };
    Object.setPrototypeOf(schema, prototype);

    expect(
      validatePartialConfiguration(schema, { inherited: "allowed" }),
    ).toEqual({
      valid: true,
      errors: [],
    });
    expect(calls).toBe(0);
  });

  it("preserves sparse-array errors and deep constraints in branches", () => {
    const sparse = new Array<unknown>(2);
    sparse[0] = "present";
    const deep = deepObject(5_000, "leaf");
    const schema: ConfigurationPropertySchema = {
      type: "array",
      anyOf: [
        {
          type: "array",
          items: { type: ["string", "object"] },
          const: sparse,
        },
      ],
      items: { type: ["string", "object"] },
    };
    const deepSchema: ConfigurationPropertySchema = {
      type: "object",
      anyOf: [{ type: "object", enum: [deep], additionalProperties: true }],
      additionalProperties: true,
    };

    const sparseErrors = validatePartialConfiguration(schema, sparse).errors;
    expect(sparseErrors[0]).toMatchObject({
      code: "invalid-value",
      path: "$",
      message: "Value must match at least one anyOf branch",
    });
    expect(sparseErrors[1]).toMatchObject({
      code: "invalid-value",
      path: "$[1]",
      message: "Array item must be present",
    });
    expect(validatePartialConfiguration(deepSchema, deep)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("preserves decimal, Unicode, and regex semantics in branches", () => {
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: {
        decimal: {
          type: "number",
          anyOf: [{ type: "number", multipleOf: 0.1 }],
        },
        scientific: {
          type: "number",
          anyOf: [{ type: "number", multipleOf: 1e-7 }],
        },
        unicode: {
          type: "string",
          allOf: [{ type: "string", minLength: 1, maxLength: 1 }],
        },
        pattern: {
          type: "string",
          oneOf: [{ type: "string", pattern: "^[a-z]+$" }],
        },
      },
      additionalProperties: false,
    };
    expect(
      validatePartialConfiguration(schema, {
        decimal: 0.3,
        scientific: 3e-7,
        unicode: "😀",
        pattern: "safe",
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("preserves prototype-collision and deep uniqueItems behavior", () => {
    const properties = Object.fromEntries([
      ["constructor", { type: "string" }],
      ["toString", { type: "string" }],
    ]);
    const objectSchema: ConfigurationPropertySchema = {
      type: "object",
      properties,
      additionalProperties: false,
      anyOf: [
        {
          type: "object",
          properties,
          additionalProperties: false,
        },
      ],
    };
    const value = Object.fromEntries([
      ["constructor", "own"],
      ["toString", "own"],
    ]);
    expect(validatePartialConfiguration(objectSchema, value)).toEqual({
      valid: true,
      errors: [],
    });

    const duplicate = deepObject(100, "same");
    const arraySchema: ConfigurationPropertySchema = {
      type: "array",
      anyOf: [{ type: "array", uniqueItems: true }],
    };
    expect(
      validatePartialConfiguration(arraySchema, [duplicate, duplicate]).errors,
    ).toEqual([
      expect.objectContaining({
        message: "Value must match at least one anyOf branch",
      }),
    ]);
  });

  it("uses defaults without mutating values, schemas, or descriptors", () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "kept", {
      configurable: true,
      enumerable: false,
      value: "descriptor",
      writable: false,
    });
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: {
        missing: {
          type: "string",
          oneOf: [{ type: "string", default: "fallback" }],
        },
      },
      additionalProperties: true,
    };
    const descriptor = Object.getOwnPropertyDescriptor(value, "kept");
    const schemaText = JSON.stringify(schema);

    expect(validateEffectiveConfiguration(schema, value)).toEqual({
      valid: true,
      errors: [],
    });
    expect(Object.getOwnPropertyDescriptor(value, "kept")).toEqual(descriptor);
    expect(Object.hasOwn(value, "missing")).toBe(false);
    expect(JSON.stringify(schema)).toBe(schemaText);
  });
});
