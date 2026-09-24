import {
  configurationPropertySchemaSchema,
  objectConfigurationPropertySchemaSchema,
} from "../src/schemas-property.js";

const scalarFields = {
  type: ["object", "null"],
  title: "Settings",
  default: { retained: true },
  description: "Service settings",
  examples: [{ enabled: true }],
  const: { enabled: true },
  enum: [{ enabled: true }],
  format: "custom",
  pattern: "^ok$",
  minLength: 0,
  maxLength: 2,
  multipleOf: 0.5,
  minimum: -1,
  maximum: 1,
  exclusiveMinimum: -2,
  exclusiveMaximum: 2,
  minItems: 0,
  maxItems: 2,
  uniqueItems: true,
  minProperties: 0,
  maxProperties: 2,
  required: ["enabled"],
  "x-weaver": {
    sensitive: true,
    visibility: "admin",
    changePolicy: "staging-gate",
    reloadBehavior: "hot",
    expressionAllowed: false,
    maxOverrideLayer: "user",
    writeRestriction: ["operator"],
    sessionMode: "restricted",
  },
};

describe("configuration property graph parser", () => {
  it("accepts the complete scalar field matrix and preserves unknown values", () => {
    const result = configurationPropertySchemaSchema.parse(scalarFields);

    expect(result).toEqual(scalarFields);
    expect(result.default).toBe(scalarFields.default);
    expect(result.const).toBe(scalarFields.const);
    expect(Object.isFrozen(result.type)).toBe(true);
    expect(Object.isFrozen(result.required)).toBe(true);
    expect(Object.isFrozen(result.examples)).toBe(true);
    expect(Object.isFrozen(result.enum)).toBe(true);
  });

  it.each([
    ["type", "invalid"],
    ["title", 1],
    ["description", false],
    ["examples", {}],
    ["enum", {}],
    ["format", 1],
    ["pattern", 1],
    ["minLength", -1],
    ["maxLength", 1.5],
    ["multipleOf", 0],
    ["minimum", "0"],
    ["maximum", "1"],
    ["exclusiveMinimum", null],
    ["exclusiveMaximum", null],
    ["minItems", -1],
    ["maxItems", 1.5],
    ["uniqueItems", "true"],
    ["minProperties", -1],
    ["maxProperties", 1.5],
    ["required", [1]],
    ["x-weaver", { unknown: true }],
  ])("rejects malformed scalar %s", (field, value) => {
    expect(
      configurationPropertySchemaSchema.safeParse({
        type: "object",
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it("clones every structural edge in deterministic traversal order", () => {
    const children = Array.from({ length: 12 }, (_, index) => ({
      type: "string",
      title: String(index),
    }));
    const input = {
      type: "object",
      properties: { first: children[0] },
      patternProperties: { "^x": children[1] },
      additionalProperties: children[2],
      items: [children[3], children[4]],
      oneOf: [children[5]],
      anyOf: [children[6]],
      allOf: [children[7]],
      not: children[8],
    };

    const parsed = configurationPropertySchemaSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.properties).not.toBe(input.properties);
    expect(parsed.items).not.toBe(input.items);
    expect(Object.isFrozen(parsed.items)).toBe(true);
    expect(Object.isFrozen(parsed.oneOf)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(false);
    expect(Object.isFrozen(parsed.properties)).toBe(false);
  });

  it("preserves aliases while keeping equal allocations distinct", () => {
    const shared = { type: "string", minLength: 1 };
    const input = {
      type: "object",
      properties: { left: shared, right: shared },
      allOf: [shared, { type: "string", minLength: 1 }],
    };

    const parsed = configurationPropertySchemaSchema.parse(input);
    const left = parsed.properties?.left;
    expect(left).toBe(parsed.properties?.right);
    expect(left).toBe(parsed.allOf?.[0]);
    expect(left).not.toBe(parsed.allOf?.[1]);
    shared.minLength = 9;
    input.properties.left = { type: "boolean" };
    expect(left?.minLength).toBe(1);
    expect(parsed.properties?.left.type).toBe("string");
  });

  it("parses a depth-5000 graph without recursive stack use", () => {
    const root: Record<string, unknown> = { type: "object" };
    let current = root;
    for (let depth = 0; depth < 5_000; depth++) {
      const child: Record<string, unknown> = { type: "object" };
      current.properties = { child };
      current = child;
    }

    expect(() =>
      objectConfigurationPropertySchemaSchema.parse(root),
    ).not.toThrow();
  });

  it.each([
    "properties",
    "patternProperties",
    "additionalProperties",
    "items",
    "tupleItems",
    "oneOf",
    "anyOf",
    "allOf",
    "not",
  ])("rejects a cycle through %s without throwing", (edge) => {
    const root: Record<string, unknown> = { type: "object" };
    if (edge === "properties") root.properties = { child: root };
    else if (edge === "patternProperties") root.patternProperties = { x: root };
    else if (edge === "additionalProperties") root.additionalProperties = root;
    else if (edge === "items") root.items = root;
    else if (edge === "tupleItems") root.items = [root];
    else if (edge === "not") root.not = root;
    else root[edge] = [root];

    expect(() =>
      configurationPropertySchemaSchema.safeParse(root),
    ).not.toThrow();
    const result = configurationPropertySchemaSchema.safeParse(root);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toContain("cycles");
  });

  it("reports malformed children at deterministic paths", () => {
    const cases = [
      [{ type: "object", properties: { bad: null } }, ["properties", "bad"]],
      [{ type: "array", items: [null] }, ["items", 0]],
      [{ type: "string", allOf: [null] }, ["allOf", 0]],
      [{ type: "string", not: null }, ["not"]],
    ] as const;
    for (const [input, path] of cases) {
      const result = configurationPropertySchemaSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(path);
    }
  });

  it("rejects unknown keys, refs, malformed containers, and sparse arrays", () => {
    const sparse = Array(2);
    sparse[1] = { type: "string" };
    for (const input of [
      { type: "object", unknown: true },
      { type: "object", $ref: "#" },
      { type: "object", $defs: {} },
      { type: "object", properties: [] },
      { type: "object", patternProperties: "bad" },
      { type: "array", items: sparse },
      { type: "object", allOf: {} },
    ]) {
      expect(configurationPropertySchemaSchema.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it("retains empty composition arrays and root policy", () => {
    const parsed = configurationPropertySchemaSchema.parse({
      type: "string",
      oneOf: [],
      anyOf: [],
      allOf: [],
    });
    expect(parsed).toEqual({ type: "string", oneOf: [], anyOf: [], allOf: [] });
    expect(
      objectConfigurationPropertySchemaSchema.safeParse(parsed).success,
    ).toBe(false);
    expect(
      objectConfigurationPropertySchemaSchema.safeParse({ type: ["object"] })
        .success,
    ).toBe(false);
  });
});

describe("configuration property graph hostile objects", () => {
  it("rejects own enumerable accessors without invocation", () => {
    let calls = 0;
    const input = { type: "object" };
    Object.defineProperty(input, "properties", {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });

    expect(configurationPropertySchemaSchema.safeParse(input).success).toBe(
      false,
    );
    expect(calls).toBe(0);
  });

  it("rejects structural array accessors without invoking numeric getters", () => {
    let calls = 0;
    const branches = [];
    Object.defineProperty(branches, "0", {
      enumerable: true,
      get() {
        calls++;
        return { type: "string" };
      },
    });
    branches.length = 1;

    expect(
      configurationPropertySchemaSchema.safeParse({
        type: "string",
        allOf: branches,
      }).success,
    ).toBe(false);
    expect(calls).toBe(0);
  });

  it("ignores inherited schema, property, and numeric getters", () => {
    let calls = 0;
    const inherited = Object.create({
      get properties() {
        calls++;
        return { bad: { type: "invalid" } };
      },
    });
    inherited.type = "object";
    const map = Object.create({
      get inherited() {
        calls++;
        return { type: "invalid" };
      },
    });
    map.own = { type: "string" };
    inherited.patternProperties = map;

    const parsed = configurationPropertySchemaSchema.parse(inherited);
    expect(calls).toBe(0);
    expect(parsed.properties).toBeUndefined();
    expect(Object.keys(parsed.patternProperties ?? {})).toEqual(["own"]);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.patternProperties)).toBe(
      Object.prototype,
    );
  });

  it("defines prototype-sensitive keys safely on ordinary output maps", () => {
    const properties = Object.create(null);
    for (const key of ["__proto__", "constructor", "prototype"]) {
      Object.defineProperty(properties, key, {
        enumerable: true,
        value: { type: "string" },
      });
    }
    const parsed = configurationPropertySchemaSchema.parse({
      type: "object",
      properties,
    });

    expect(Object.keys(parsed.properties ?? {})).toEqual([
      "__proto__",
      "constructor",
      "prototype",
    ]);
    expect(Object.getPrototypeOf(parsed.properties)).toBe(Object.prototype);
    expect(parsed.properties?.__proto__?.type).toBe("string");
    expect(Reflect.get(Object.prototype, "type")).toBeUndefined();
  });

  it("leaves source descriptors, arrays, and prototypes unchanged", () => {
    const child = { type: "string" };
    const branches = Object.freeze([child]);
    const input = Object.create(null);
    Object.defineProperty(input, "type", {
      configurable: false,
      enumerable: true,
      value: "object",
      writable: false,
    });
    input.allOf = branches;
    const before = Object.getOwnPropertyDescriptor(input, "type");

    const parsed = configurationPropertySchemaSchema.parse(input);
    expect(Object.getOwnPropertyDescriptor(input, "type")).toEqual(before);
    expect(Object.getPrototypeOf(input)).toBe(null);
    expect(input.allOf).toBe(branches);
    expect(Object.isFrozen(branches)).toBe(true);
    expect(Object.isFrozen(parsed.allOf)).toBe(true);
    expect(parsed.allOf).not.toBe(branches);
  });
});
