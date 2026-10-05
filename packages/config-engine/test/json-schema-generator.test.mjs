import {
  generateJsonSchema,
  generateSinglePropertySchema,
} from "../dist/json-schema-generator.js";

/** @param {object} schema */
function entry(ownerId, schema) {
  return { ownerId, fullyQualifiedKey: "test.key", schema };
}

describe("generateSinglePropertySchema", () => {
  it("maps string type", () => {
    const result = generateSinglePropertySchema(
      "example.shell.theme",
      entry("example.shell", { type: "string" }),
    );
    expect(result.type).toBe("string");
  });

  it("maps number type with min/max", () => {
    const result = generateSinglePropertySchema(
      "example.map.zoom",
      entry("example.map", { type: "number", minimum: 1, maximum: 20 }),
    );
    expect(result.type).toBe("number");
    expect(result.minimum).toBe(1);
    expect(result.maximum).toBe(20);
  });

  it("maps boolean type", () => {
    const result = generateSinglePropertySchema(
      "example.shell.enabled",
      entry("example.shell", { type: "boolean" }),
    );
    expect(result.type).toBe("boolean");
  });

  it("maps object type", () => {
    const result = generateSinglePropertySchema(
      "example.shell.layout",
      entry("example.shell", { type: "object" }),
    );
    expect(result.type).toBe("object");
  });

  it("maps array type", () => {
    const result = generateSinglePropertySchema(
      "example.shell.plugins",
      entry("example.shell", { type: "array" }),
    );
    expect(result.type).toBe("array");
  });

  it("preserves description", () => {
    const result = generateSinglePropertySchema(
      "example.shell.theme",
      entry("example.shell", { type: "string", description: "UI theme" }),
    );
    expect(result.description).toBe("UI theme");
  });

  it("preserves default value", () => {
    const result = generateSinglePropertySchema(
      "example.shell.theme",
      entry("example.shell", { type: "string", default: "dark" }),
    );
    expect(result.default).toBe("dark");
  });

  it("preserves enum values", () => {
    const result = generateSinglePropertySchema(
      "example.shell.theme",
      entry("example.shell", { type: "string", enum: ["dark", "light"] }),
    );
    expect(result.enum).toEqual(["dark", "light"]);
  });

  it("preserves nested JSON Schema structures", () => {
    const result = generateSinglePropertySchema(
      "example.shell.layout",
      entry("example.shell", {
        type: "object",
        required: ["panels"],
        properties: {
          panels: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string" },
                width: { type: "integer", minimum: 1 },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      }),
    );

    expect(result.type).toBe("object");
    expect(result.required).toEqual(["panels"]);
    expect(result.additionalProperties).toBe(false);
    expect(result.properties.panels.type).toBe("array");
    expect(result.properties.panels.minItems).toBe(1);
    expect(result.properties.panels.items.type).toBe("object");
    expect(result.properties.panels.items.properties.width.type).toBe("integer");
    expect(result.properties.panels.items.additionalProperties).toBe(false);
  });

  it("preserves union JSON schema type arrays", () => {
    const result = generateSinglePropertySchema(
      "example.shell.sidebarWidth",
      entry("example.shell", {
        type: ["integer", "null"],
        minimum: 10,
      }),
    );

    expect(result.type).toEqual(["integer", "null"]);
    expect(result.minimum).toBe(10);
  });

  it("emits all composition keywords recursively without mutation", () => {
    const schema = {
      type: "object",
      properties: {
        choice: {
          type: "string",
          anyOf: [{ type: "string", const: "a" }],
          oneOf: [{ type: "string", minLength: 1 }],
          allOf: [{ type: "string", maxLength: 2 }],
          not: { type: "string", const: "blocked" },
        },
      },
      additionalProperties: false,
    };
    const before = JSON.stringify(schema);
    const result = generateSinglePropertySchema(
      "example.shell.choice",
      entry("example.shell", schema),
    );

    expect(result.properties.choice).toMatchObject({
      anyOf: [{ type: "string", const: "a" }],
      oneOf: [{ type: "string", minLength: 1 }],
      allOf: [{ type: "string", maxLength: 2 }],
      not: { type: "string", const: "blocked" },
    });
    expect(JSON.stringify(schema)).toBe(before);
  });

  it("populates x-weaver extension object", () => {
    const result = generateSinglePropertySchema(
      "example.shell.theme",
      entry("example.shell", {
        type: "string",
        "x-weaver": {
          changePolicy: "full-pipeline",
          visibility: "public",
          reloadBehavior: "hot",
        },
      }),
    );
    expect(result["x-weaver"]).toEqual({
      namespace: "example.shell",
      changePolicy: "full-pipeline",
      visibility: "public",
      reloadBehavior: "hot",
    });
  });

  it("omits optional fields when not present in schema", () => {
    const result = generateSinglePropertySchema(
      "example.shell.theme",
      entry("example.shell", { type: "string" }),
    );
    expect(result.description).toBe(undefined);
    expect(result.default).toBe(undefined);
    expect(result.enum).toBe(undefined);
    expect(result.minimum).toBe(undefined);
    expect(result.maximum).toBe(undefined);
    expect(result["x-weaver"].changePolicy).toBe(undefined);
    expect(result["x-weaver"].namespace).toBe("example.shell");
  });

  it("emits sensitive field in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "example.shell.secret",
      entry("example.shell", { type: "string", "x-weaver": { sensitive: true } }),
    );
    expect(result["x-weaver"].sensitive).toBe(true);
  });

  it("emits maxOverrideLayer in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "example.shell.key",
      entry("example.shell", { type: "string", "x-weaver": { maxOverrideLayer: "user" } }),
    );
    expect(result["x-weaver"].maxOverrideLayer).toBe("user");
  });

  it("emits writeRestriction in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "example.shell.key",
      entry("example.shell", { type: "string", "x-weaver": { writeRestriction: ["admin", "platform"] } }),
    );
    expect(result["x-weaver"].writeRestriction).toEqual(["admin", "platform"]);
  });

  it("emits sessionMode in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "example.shell.key",
      entry("example.shell", { type: "string", "x-weaver": { sessionMode: "ephemeral" } }),
    );
    expect(result["x-weaver"].sessionMode).toBe("ephemeral");
  });

  it("emits expressionAllowed in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "example.shell.key",
      entry("example.shell", { type: "string", "x-weaver": { expressionAllowed: true } }),
    );
    expect(result["x-weaver"].expressionAllowed).toBe(true);
  });

  it("omits undefined extension fields from x-weaver", () => {
    const result = generateSinglePropertySchema(
      "example.shell.key",
      entry("example.shell", { type: "string" }),
    );
    const xw = result["x-weaver"];
    expect(Object.prototype.hasOwnProperty.call(xw, "sensitive")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xw, "maxOverrideLayer")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xw, "writeRestriction")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xw, "sessionMode")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xw, "expressionAllowed")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xw, "instanceOverridable")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xw, "viewConfig")).toBe(false);
  });
});

describe("generateJsonSchema", () => {
  it("composes multiple schemas into a valid JSON Schema document", () => {
    const schemas = new Map();
    schemas.set("example.shell.theme", {
      ownerId: "example.shell",
      fullyQualifiedKey: "example.shell.theme",
      schema: { type: "string", default: "dark", description: "UI theme" },
    });
    schemas.set("example.map.zoom", {
      ownerId: "example.map",
      fullyQualifiedKey: "example.map.zoom",
      schema: { type: "number", minimum: 1, maximum: 20, default: 5 },
    });

    const doc = generateJsonSchema(schemas);
    expect(doc.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(doc.title).toBe("Weaver Configuration Schema");
    expect(doc.type).toBe("object");
    expect(doc.additionalProperties).toBe(false);
    expect(Object.keys(doc.properties).length).toBe(2);
    expect(doc.properties["example.shell.theme"].type).toBe("string");
    expect(doc.properties["example.map.zoom"].type).toBe("number");
  });

  it("uses custom title when provided", () => {
    const doc = generateJsonSchema(new Map(), { title: "Custom Title" });
    expect(doc.title).toBe("Custom Title");
  });

  it("handles empty schema map", () => {
    const doc = generateJsonSchema(new Map());
    expect(doc.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(Object.keys(doc.properties).length).toBe(0);
  });
});
