import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

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

const compositionKeywords = ["oneOf", "anyOf", "allOf", "not"] as const;

type CompositionKeyword = (typeof compositionKeywords)[number];

function expectPublicResultCompatible(result: unknown): void {
  expect(() => schemaValidationResultSchema.parse(result)).not.toThrow();
}

function addComposition(
  keyword: CompositionKeyword,
  schema: ConfigurationPropertySchema,
  nested: ConfigurationPropertySchema,
): ConfigurationPropertySchema {
  if (keyword === "not") return { ...schema, not: nested };
  return { ...schema, [keyword]: [nested] };
}

function schemaWithComposition(
  keyword: CompositionKeyword,
): ConfigurationPropertySchema {
  const nested: ConfigurationPropertySchema = { type: "string" };
  return addComposition(keyword, { type: "string" }, nested);
}

function schemaWithRootPatchComposition(
  keyword: CompositionKeyword,
): ConfigurationPropertySchema {
  const objectSchema: ConfigurationPropertySchema = {
    type: "object",
    properties: { x: { type: "string" } },
    additionalProperties: false,
  };
  return addComposition(keyword, objectSchema, objectSchema);
}

function schemaWithAncestorPatchComposition(
  keyword: CompositionKeyword,
): ConfigurationPropertySchema {
  const ancestorSchema: ConfigurationPropertySchema = {
    type: "object",
    properties: { x: { type: "string" } },
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      group: addComposition(keyword, ancestorSchema, ancestorSchema),
    },
    additionalProperties: false,
  };
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

  it.each(
    compositionKeywords,
  )("rejects unsupported %s composition schemas as invalid-schema", (keyword) => {
    const schema = schemaWithComposition(keyword);

    const result = validatePartialConfiguration(schema, "blocked");

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-schema",
      path: "$",
    });
  });

  it.each(
    compositionKeywords,
  )("rejects root %s composition during patch path resolution", (keyword) => {
    const result = validateConfigurationPatch(
      schemaWithRootPatchComposition(keyword),
      "x",
      "ok",
    );

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-schema",
      path: "$",
    });
    expectPublicResultCompatible(result);
  });

  it.each(
    compositionKeywords,
  )("rejects ancestor %s composition during patch path resolution", (keyword) => {
    const result = validateConfigurationPatch(
      schemaWithAncestorPatchComposition(keyword),
      ["group", "x"],
      "ok",
    );

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "invalid-schema",
      path: "$.group",
    });
    expectPublicResultCompatible(result);
  });
});
