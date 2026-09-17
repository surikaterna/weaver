import {
  generateJsonSchema,
  generateSinglePropertySchema,
} from "../dist/json-schema-generator.js";

/** @param {object} schema */
function entry(_source, schema) {
  return { schema };
}

describe("generateSinglePropertySchema", () => {
  it("maps string type", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string" }),
    );
    expect(result.type).toBe("string");
  });

  it("maps number type with min/max", () => {
    const result = generateSinglePropertySchema(
      "ghost.map.zoom",
      entry("ghost.map", { type: "number", minimum: 1, maximum: 20 }),
    );
    expect(result.type).toBe("number");
    expect(result.minimum).toBe(1);
    expect(result.maximum).toBe(20);
  });

  it("maps boolean type", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.enabled",
      entry("ghost.shell", { type: "boolean" }),
    );
    expect(result.type).toBe("boolean");
  });

  it("maps object type", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.layout",
      entry("ghost.shell", { type: "object" }),
    );
    expect(result.type).toBe("object");
  });

  it("maps array type", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.plugins",
      entry("ghost.shell", { type: "array" }),
    );
    expect(result.type).toBe("array");
  });

  it("preserves description", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string", description: "UI theme" }),
    );
    expect(result.description).toBe("UI theme");
  });

  it("preserves default value", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string", default: "dark" }),
    );
    expect(result.default).toBe("dark");
  });

  it("preserves enum values", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string", enum: ["dark", "light"] }),
    );
    expect(result.enum).toEqual(["dark", "light"]);
  });

  it("preserves nested JSON Schema structures", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.layout",
      entry("ghost.shell", {
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
      "ghost.shell.sidebarWidth",
      entry("ghost.shell", {
        type: ["integer", "null"],
        minimum: 10,
      }),
    );

    expect(result.type).toEqual(["integer", "null"]);
    expect(result.minimum).toBe(10);
  });

  it("populates x-weaver extension object", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.theme",
      entry("ghost.shell", {
        type: "string",
        "x-weaver": {
          changePolicy: "full-pipeline",
          visibility: "public",
          reloadBehavior: "hot",
        },
      }),
    );
    expect(result["x-weaver"]).toEqual({
      changePolicy: "full-pipeline",
      visibility: "public",
      reloadBehavior: "hot",
    });
  });

  it("omits optional fields when not present in schema", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string" }),
    );
    expect(result.description).toBe(undefined);
    expect(result.default).toBe(undefined);
    expect(result.enum).toBe(undefined);
    expect(result.minimum).toBe(undefined);
    expect(result.maximum).toBe(undefined);
    expect(result["x-weaver"].changePolicy).toBe(undefined);
    expect(result["x-weaver"]).toEqual({});
  });

  it("emits sensitive field in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.secret",
      entry("ghost.shell", { type: "string", "x-weaver": { sensitive: true } }),
    );
    expect(result["x-weaver"].sensitive).toBe(true);
  });

  it("emits maxOverrideLayer in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.key",
      entry("ghost.shell", { type: "string", "x-weaver": { maxOverrideLayer: "user" } }),
    );
    expect(result["x-weaver"].maxOverrideLayer).toBe("user");
  });

  it("emits writeRestriction in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.key",
      entry("ghost.shell", { type: "string", "x-weaver": { writeRestriction: ["admin", "platform"] } }),
    );
    expect(result["x-weaver"].writeRestriction).toEqual(["admin", "platform"]);
  });

  it("emits sessionMode in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.key",
      entry("ghost.shell", { type: "string", "x-weaver": { sessionMode: "ephemeral" } }),
    );
    expect(result["x-weaver"].sessionMode).toBe("ephemeral");
  });

  it("emits expressionAllowed in x-weaver when present", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.key",
      entry("ghost.shell", { type: "string", "x-weaver": { expressionAllowed: true } }),
    );
    expect(result["x-weaver"].expressionAllowed).toBe(true);
  });

  it("omits undefined extension fields from x-weaver", () => {
    const result = generateSinglePropertySchema(
      "ghost.shell.key",
      entry("ghost.shell", { type: "string" }),
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
    schemas.set("ghost.shell.theme", {
      schema: { type: "string", default: "dark", description: "UI theme" },
    });
    schemas.set("ghost.map.zoom", {
      schema: { type: "number", minimum: 1, maximum: 20, default: 5 },
    });

    const doc = generateJsonSchema(schemas);
    expect(doc.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(doc.title).toBe("Weaver Configuration Schema");
    expect(doc.type).toBe("object");
    expect(doc.additionalProperties).toBe(false);
    expect(Object.keys(doc.properties).length).toBe(2);
    expect(doc.properties["ghost.shell.theme"].type).toBe("string");
    expect(doc.properties["ghost.map.zoom"].type).toBe("number");
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
