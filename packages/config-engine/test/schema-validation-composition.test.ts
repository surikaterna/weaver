import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  validateConfigurationPatch,
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "../src/schema-validation.js";
import { schemaValidationResultSchema } from "../src/schema-validation-schemas.js";

const numberBranch: ConfigurationPropertySchema = { type: "number" };
const positiveBranch: ConfigurationPropertySchema = {
  type: "number",
  minimum: 0,
};
const smallBranch: ConfigurationPropertySchema = {
  type: "number",
  maximum: 10,
};

function expectCompatible(result: unknown): void {
  expect(schemaValidationResultSchema.safeParse(result).success).toBe(true);
}

function summary(message: string, segments: readonly (string | number)[] = []) {
  return {
    code: "invalid-value",
    path: segments.reduce(
      (path, segment) =>
        typeof segment === "number"
          ? `${path}[${String(segment)}]`
          : `${path}.${segment}`,
      "$",
    ),
    segments,
    message,
  };
}

describe("schema composition semantics", () => {
  it.each([
    { value: "x", valid: false },
    { value: -1, valid: true },
    { value: 5, valid: true },
  ])("applies anyOf at-least-one matching to $value", ({ value, valid }) => {
    const schema: ConfigurationPropertySchema = {
      type: ["number", "string"],
      anyOf: [positiveBranch, smallBranch],
    };
    const result = validatePartialConfiguration(schema, value);
    expect(result.valid).toBe(valid);
    if (!valid) {
      expect(result.errors).toEqual([
        summary("Value must match at least one anyOf branch"),
      ]);
    }
    expectCompatible(result);
  });

  it.each([
    { value: "x", matched: 0, valid: false },
    { value: -1, matched: 1, valid: true },
    { value: 5, matched: 2, valid: false },
  ])("applies oneOf exactly-one matching to $value", ({
    value,
    matched,
    valid,
  }) => {
    const schema: ConfigurationPropertySchema = {
      type: ["number", "string"],
      oneOf: [positiveBranch, smallBranch],
    };
    const result = validatePartialConfiguration(schema, value);
    expect(result.valid).toBe(valid);
    if (!valid) {
      expect(result.errors).toEqual([
        summary(
          `Value must match exactly one oneOf branch (matched ${String(matched)})`,
        ),
      ]);
    }
    expectCompatible(result);
  });

  it.each([
    { value: 5, matched: 2, valid: true },
    { value: 20, matched: 1, valid: false },
    { value: "x", matched: 0, valid: false },
  ])("applies allOf all-branches matching to $value", ({
    value,
    matched,
    valid,
  }) => {
    const schema: ConfigurationPropertySchema = {
      type: ["number", "string"],
      allOf: [positiveBranch, smallBranch],
    };
    const result = validatePartialConfiguration(schema, value);
    expect(result.valid).toBe(valid);
    if (!valid) {
      expect(result.errors).toEqual([
        summary(
          `Value must match every allOf branch (matched ${String(matched)} of 2)`,
        ),
      ]);
    }
    expectCompatible(result);
  });

  it.each([
    { value: "allowed", valid: true },
    { value: 1, valid: false },
  ])("inverts the not child match for $value", ({ value, valid }) => {
    const schema: ConfigurationPropertySchema = {
      type: ["number", "string"],
      not: numberBranch,
    };
    const result = validatePartialConfiguration(schema, value);
    expect(result.valid).toBe(valid);
    if (!valid) {
      expect(result.errors).toEqual([
        summary("Value must not match the not schema"),
      ]);
    }
  });

  it("orders all keyword summaries before sibling constraint errors", () => {
    const schema: ConfigurationPropertySchema = {
      type: "number",
      minimum: 10,
      anyOf: [{ type: "number", const: 0 }],
      oneOf: [numberBranch, numberBranch],
      allOf: [
        { type: "number", maximum: 0 },
        { type: "number", minimum: 10 },
      ],
      not: numberBranch,
    };

    const result = validatePartialConfiguration(schema, 5);
    expect(result.errors).toEqual([
      summary("Value must match at least one anyOf branch"),
      summary("Value must match exactly one oneOf branch (matched 2)"),
      summary("Value must match every allOf branch (matched 0 of 2)"),
      summary("Value must not match the not schema"),
      expect.objectContaining({
        code: "invalid-value",
        path: "$",
        message: "minimum requires 5 >= 10",
      }),
    ]);
    expect(result.errors.every((error) => error.expected === undefined)).toBe(
      true,
    );
    expect(result.errors.every((error) => error.actual === undefined)).toBe(
      true,
    );
  });

  it("supports nested composition at every structural schema location", () => {
    const stringChoice: ConfigurationPropertySchema = {
      type: "string",
      anyOf: [
        { type: "string", const: "a" },
        { type: "string", const: "b" },
      ],
    };
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: {
        property: stringChoice,
        list: { type: "array", items: stringChoice },
        tuple: {
          type: "array",
          items: [
            stringChoice,
            { type: "number", not: { type: "number", const: 0 } },
          ],
        },
      },
      patternProperties: { "^pattern-": stringChoice },
      additionalProperties: stringChoice,
    };

    expect(
      validatePartialConfiguration(schema, {
        property: "a",
        "pattern-name": "b",
        extra: "a",
        list: ["a", "b"],
        tuple: ["b", 1],
      }),
    ).toEqual({ valid: true, errors: [] });
    const invalid = validatePartialConfiguration(schema, { property: "c" });
    expect(invalid.errors).toEqual([
      summary("Value must match at least one anyOf branch", ["property"]),
    ]);
  });

  it("evaluates recursively nested composition without leaking branch errors", () => {
    const schema: ConfigurationPropertySchema = {
      type: "number",
      anyOf: [
        {
          type: "number",
          oneOf: [
            { type: "number", const: 1 },
            { type: "number", const: 2 },
          ],
        },
      ],
    };
    expect(validatePartialConfiguration(schema, 2)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validatePartialConfiguration(schema, 3).errors).toEqual([
      summary("Value must match at least one anyOf branch"),
    ]);
  });
});

describe("composition modes and patch projection", () => {
  it("keeps partial omissions permissive and effective completeness conjunctive", () => {
    const schema: ConfigurationPropertySchema = {
      type: "object",
      minProperties: 1,
      required: ["name"],
      properties: { name: { type: "string" } },
      allOf: [{ type: "object", minProperties: 1, additionalProperties: true }],
      additionalProperties: false,
    };
    expect(validatePartialConfiguration(schema, {})).toEqual({
      valid: true,
      errors: [],
    });
    const effective = validateEffectiveConfiguration(schema, {});
    expect(effective.errors.map((error) => error.code)).toEqual([
      "invalid-value",
      "invalid-value",
      "missing-required",
    ]);
  });

  it("uses independent branch defaults and reports oneOf ambiguity first", () => {
    const ambiguous: ConfigurationPropertySchema = {
      type: "string",
      oneOf: [
        { type: "string", default: "a" },
        { type: "string", default: "b" },
      ],
    };
    const oneDefault: ConfigurationPropertySchema = {
      type: "string",
      oneOf: [{ type: "string", default: "a" }, { type: "number" }],
    };

    expect(validatePartialConfiguration(ambiguous, undefined).errors).toEqual([
      summary("Value must match exactly one oneOf branch (matched 0)"),
      expect.objectContaining({ code: "invalid-type", actual: "undefined" }),
    ]);
    expect(validateEffectiveConfiguration(ambiguous, undefined).errors).toEqual(
      [
        summary("Value must match exactly one oneOf branch (matched 2)"),
        expect.objectContaining({ code: "invalid-type", actual: "undefined" }),
      ],
    );
    expect(
      validateEffectiveConfiguration(oneDefault, undefined).errors,
    ).toEqual([
      expect.objectContaining({ code: "invalid-type", actual: "undefined" }),
    ]);
  });

  it("requires the parent property schema to own a required default", () => {
    const branchOnly: ConfigurationPropertySchema = {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          anyOf: [{ type: "string", default: "branch" }],
        },
      },
      additionalProperties: false,
    };
    const parentDefault: ConfigurationPropertySchema = {
      ...branchOnly,
      properties: {
        name: {
          type: "string",
          default: "parent",
          anyOf: [{ type: "string", const: "parent" }],
        },
      },
    };
    expect(
      validateEffectiveConfiguration(branchOnly, {}).errors[0],
    ).toMatchObject({
      code: "missing-required",
      path: "$.name",
    });
    expect(validateEffectiveConfiguration(parentDefault, {})).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("fully validates leaf composition and conservatively projects ancestors", () => {
    const leaf: ConfigurationPropertySchema = {
      type: "object",
      additionalProperties: true,
      anyOf: [
        {
          type: "object",
          properties: { value: { type: "number" } },
          additionalProperties: true,
        },
      ],
      oneOf: [
        {
          type: "object",
          properties: { value: { type: "number" } },
          additionalProperties: true,
        },
        {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: true,
        },
      ],
      not: {
        type: "object",
        required: ["blocked"],
        additionalProperties: true,
      },
      allOf: [
        {
          type: "object",
          properties: { value: { type: "number" } },
          additionalProperties: true,
        },
      ],
    };
    const schema: ConfigurationPropertySchema = {
      type: "object",
      properties: {
        group: {
          type: "object",
          additionalProperties: true,
          anyOf: [leaf],
          oneOf: [leaf, leaf],
          not: leaf,
          allOf: [
            {
              type: "object",
              properties: { value: { type: "number", minimum: 1 } },
              additionalProperties: true,
            },
          ],
        },
        leaf,
      },
      additionalProperties: false,
    };

    expect(validateConfigurationPatch(schema, ["group", "value"], 1)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateConfigurationPatch(schema, ["group", "value"], 0).errors[0],
    ).toMatchObject({ code: "invalid-value", path: "$.group.value" });
    expect(
      validateConfigurationPatch(schema, "leaf", { value: true }).errors,
    ).toEqual([
      summary("Value must match at least one anyOf branch", ["leaf"]),
      summary("Value must match exactly one oneOf branch (matched 0)", [
        "leaf",
      ]),
      summary("Value must match every allOf branch (matched 0 of 1)", ["leaf"]),
      summary("Value must not match the not schema", ["leaf"]),
    ]);
  });
});
