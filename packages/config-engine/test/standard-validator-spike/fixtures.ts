import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import type { Fixture } from "./types.js";

const objectSchema: ConfigurationPropertySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 5 },
    count: { type: "integer", minimum: 1, maximum: 10 },
  },
};

// biome-ignore format: The data-driven corpus stays dense to make the spike LOC bound meaningful.
const cases: Fixture[] = [
  valid("primitive-null", "primitive", { type: "null" }, null),
  valid("primitive-boolean", "primitive", { type: "boolean" }, true),
  valid("primitive-string", "primitive", { type: "string" }, "ok"),
  valid("primitive-number", "primitive", { type: "number" }, 1.5),
  valid("primitive-integer", "primitive", { type: "integer" }, 2),
  valid("primitive-union", "primitive", { type: ["string", "null"] }, null),
  invalid("type-invalid", "primitive", { type: "boolean" }, "true", "invalid-type", "$"),
  valid("object-valid", "object", objectSchema, { name: "Ada", count: 2 }, "effective"),
  invalid("required-effective", "required", objectSchema, {}, "missing-required", "$.name", "effective"),
  valid("required-partial", "required", objectSchema, {}, "partial"),
  invalid("closed-default", "additionalProperties", objectSchema, { other: 1 }, "unknown-property", "$.other"),
  invalid("additional-false", "additionalProperties", { type: "object", additionalProperties: false }, { x: 1 }, "unknown-property", "$.x"),
  valid("additional-true", "additionalProperties", { type: "object", additionalProperties: true }, { x: 1 }),
  valid("additional-typed", "additionalProperties", { type: "object", additionalProperties: { type: "string" } }, { x: "yes" }),
  invalid("additional-typed-invalid", "additionalProperties", { type: "object", additionalProperties: { type: "string" } }, { x: 1 }, "invalid-type", "$.x"),
  valid("pattern-properties-overlap", "patternProperties", { type: "object", patternProperties: { "^x": { type: "string" }, "x$": { minLength: 2, type: "string" } } }, { x: "ok" }),
  invalid("pattern-properties-overlap-invalid", "patternProperties", { type: "object", patternProperties: { "^x": { minLength: 2, type: "string" }, "x$": { pattern: "^a", type: "string" } } }, { x: "x" }, "invalid-value", "$.x"),
  valid("array-items", "items", { type: "array", items: { type: "integer" } }, [1, 2]),
  invalid("array-items-invalid", "items", { type: "array", items: { type: "integer" } }, [1, "2"], "invalid-type", "$[1]"),
  valid("tuple-items", "items", { type: "array", items: [{ type: "string" }, { type: "number" }] }, ["a", 2]),
  valid("const", "const", { type: "string", const: "x" }, "x"),
  invalid("const-invalid", "const", { type: "string", const: "x" }, "y", "invalid-value", "$"),
  valid("enum", "enum", { type: "string", enum: ["x", "y"] }, "y"),
  invalid("enum-invalid", "enum", { type: "string", enum: ["x", "y"] }, "z", "invalid-value", "$"),
  valid("pattern", "pattern", { type: "string", pattern: "^[a-z]+$" }, "abc"),
  invalid("pattern-invalid", "pattern", { type: "string", pattern: "^[a-z]+$" }, "123", "invalid-value", "$"),
  valid("unicode-length", "string-constraints", { type: "string", minLength: 1, maxLength: 1 }, "😀"),
  invalid("min-length", "string-constraints", { type: "string", minLength: 2 }, "a", "invalid-value", "$"),
  invalid("max-length", "string-constraints", { type: "string", maxLength: 1 }, "ab", "invalid-value", "$"),
  valid("numeric-bounds", "numeric-constraints", { type: "number", minimum: 1, maximum: 3 }, 2),
  invalid("minimum", "numeric-constraints", { type: "number", minimum: 1 }, 0, "invalid-value", "$"),
  invalid("maximum", "numeric-constraints", { type: "number", maximum: 3 }, 4, "invalid-value", "$"),
  invalid("exclusive-minimum", "numeric-constraints", { type: "number", exclusiveMinimum: 1 }, 1, "invalid-value", "$"),
  invalid("exclusive-maximum", "numeric-constraints", { type: "number", exclusiveMaximum: 3 }, 3, "invalid-value", "$"),
  valid("multiple-decimal", "multipleOf", { type: "number", multipleOf: 0.1 }, 0.3),
  valid("multiple-decimal-003", "multipleOf", { type: "number", multipleOf: 0.03 }, 1.2),
  valid("multiple-scientific", "multipleOf", { type: "number", multipleOf: 1e-7 }, 3e-7),
  invalid("multiple-nonmultiple", "multipleOf", { type: "number", multipleOf: 0.1 }, 0.31, "invalid-value", "$"),
  invalid("multiple-invalid-schema", "multipleOf", { type: "number", multipleOf: 0 }, 1, "invalid-schema", "$"),
  valid("array-cardinality", "array-constraints", { type: "array", minItems: 1, maxItems: 2 }, [1]),
  invalid("min-items", "array-constraints", { type: "array", minItems: 1 }, [], "invalid-value", "$"),
  invalid("max-items", "array-constraints", { type: "array", maxItems: 1 }, [1, 2], "invalid-value", "$"),
  invalid("unique-items", "array-constraints", { type: "array", uniqueItems: true }, [{ x: 1 }, { x: 1 }], "invalid-value", "$[1]"),
  valid("object-cardinality", "object-constraints", { type: "object", minProperties: 1, maxProperties: 2, additionalProperties: true }, { x: 1 }, "effective"),
  invalid("min-properties", "object-constraints", { type: "object", minProperties: 1, additionalProperties: true }, {}, "invalid-value", "$", "effective"),
  valid("min-properties-partial", "object-constraints", { type: "object", minProperties: 1, additionalProperties: true }, {}, "partial"),
  invalid("max-properties", "object-constraints", { type: "object", maxProperties: 1, additionalProperties: true }, { x: 1, y: 2 }, "invalid-value", "$"),
  valid("root-patch", "patch", { type: "string" }, "x", "partial", { path: [] }),
  invalid("member-patch", "patch", objectSchema, 0, "invalid-type", "$.name", "partial", { path: "name" }),
  invalid("member-patch-base", "patch", objectSchema, 0, "invalid-type", "$.settings.name", "partial", { path: ["name"], options: { path: ["settings"] } }),
  valid("default-effective", "defaults", { type: "string", default: "x" }, undefined, "effective"),
  invalid("default-partial", "defaults", { type: "string", default: "x" }, undefined, "invalid-type", "$", "partial"),
  valid("required-default-effective", "defaults", { type: "object", required: ["x"], properties: { x: { type: "string", default: "ok" } } }, {}, "effective"),
  valid("own-undefined-default-effective", "defaults", { type: "object", properties: { x: { type: "string", default: "ok" } } }, { x: undefined }, "effective"),
  valid("prototype-own", "prototype-safety", { type: "object", additionalProperties: { type: "string" } }, collisionValue()),
  valid("inherited-value-member", "getter-safety", { type: "object" }, inheritedValue()),
  valid("mutation-valid", "mutation", { type: "object", properties: { x: { type: "string", default: "ok" } } }, {}),
  invalid("mutation-invalid", "mutation", { type: "object", properties: { x: { type: "integer" } } }, { x: "bad" }, "invalid-type", "$.x"),
  invalid("deterministic-error-order", "error-order", { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } }, { a: "x", b: "y" }, "invalid-type", "$.a"),
  valid("shared-reference", "graph-safety", sharedSchema(), { left: { x: "a" }, right: { x: "b" } }),
  invalid("sparse-array", "graph-safety", { type: "array", items: { type: "string" } }, sparseArray(), "invalid-value", "$[0]", "partial", undefined, true),
  invalid("cyclic-value", "graph-safety", { type: "object", additionalProperties: true }, cyclicValue(), "invalid-value", "$.self", "partial", undefined, true),
  invalid("cyclic-schema", "graph-safety", cyclicSchema(), {}, "invalid-schema", "$", "partial", undefined, true),
  valid("depth-5000", "graph-safety", ...deepFixture(5_000)),
  invalid("composition-admission", "composition", { type: "string", oneOf: [{ type: "string" }] }, "x", "invalid-schema", "$", "partial", undefined, false, false),
];

export const fixtures: readonly Fixture[] = cases;

function valid(
  id: string,
  category: string,
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: Fixture["mode"] = "partial",
  patch?: Fixture["patch"],
): Fixture {
  return { id, category, schema, value, mode, patch, expectedValid: true };
}

function invalid(
  id: string,
  category: string,
  schema: ConfigurationPropertySchema,
  value: unknown,
  code: NonNullable<Fixture["expectedFirst"]>["code"],
  path: string,
  mode: Fixture["mode"] = "partial",
  patch?: Fixture["patch"],
  security = false,
  admitted = true,
): Fixture {
  return {
    id,
    category,
    schema,
    value,
    mode,
    patch,
    expectedValid: false,
    expectedFirst: { code, path },
    security,
    admitted,
  };
}

function collisionValue(): Record<string, unknown> {
  return JSON.parse(
    '{"__proto__":"ok","constructor":"ok","prototype":"ok","toString":"ok"}',
  );
}

function inheritedValue(): Record<string, unknown> {
  return Object.create({ inherited: "ignored" }) as Record<string, unknown>;
}

function sparseArray(): unknown[] {
  const value = new Array<unknown>(2);
  value[1] = "present";
  return value;
}

function cyclicValue(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

function cyclicSchema(): ConfigurationPropertySchema {
  const properties: Record<string, ConfigurationPropertySchema> = {};
  const schema: ConfigurationPropertySchema = { type: "object", properties };
  properties.self = schema;
  return schema;
}

function sharedSchema(): ConfigurationPropertySchema {
  const child: ConfigurationPropertySchema = {
    type: "object",
    properties: { x: { type: "string" } },
  };
  return { type: "object", properties: { left: child, right: child } };
}

function deepFixture(depth: number): [ConfigurationPropertySchema, unknown] {
  let schema: ConfigurationPropertySchema = { type: "string" };
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index++) {
    schema = { type: "object", properties: { next: schema } };
    value = { next: value };
  }
  return [schema, value];
}
