import {
  generateZodSchemaSource,
  generateZodForProperty,
  sanitizeKeyToIdentifier,
} from "../dist/zod-schema-generator.js";

/** @param {object} schema */
function entry(ownerId, schema) {
  return { ownerId, fullyQualifiedKey: "test.key", schema };
}

describe("sanitizeKeyToIdentifier", () => {
  it("converts dots to underscores", () => {
    expect(sanitizeKeyToIdentifier("example.shell.theme")).toBe("example_shell_theme");
  });

  it("converts hyphens to underscores", () => {
    expect(sanitizeKeyToIdentifier("example.vessel-view.zoom")).toBe("example_vessel_view_zoom");
  });

  it("converts dots and hyphens together", () => {
    expect(sanitizeKeyToIdentifier("example.my-plugin.setting")).toBe("example_my_plugin_setting");
  });
});

describe("generateZodForProperty", () => {
  it("generates z.string() for string type", () => {
    const result = generateZodForProperty(
      "example.shell.theme",
      entry("example.shell", { type: "string" }),
    );
    expect(result).toBe("z.string()");
  });

  it("generates z.number() with min/max for number type", () => {
    const result = generateZodForProperty(
      "example.map.zoom",
      entry("example.map", { type: "number", minimum: 1, maximum: 20 }),
    );
    expect(result).toBe("z.number().min(1).max(20)");
  });

  it("generates z.boolean() for boolean type", () => {
    const result = generateZodForProperty(
      "example.shell.enabled",
      entry("example.shell", { type: "boolean" }),
    );
    expect(result).toBe("z.boolean()");
  });

  it("generates z.record for object type", () => {
    const result = generateZodForProperty(
      "example.shell.layout",
      entry("example.shell", { type: "object" }),
    );
    expect(result).toBe("z.record(z.string(), z.unknown())");
  });

  it("generates z.array for array type", () => {
    const result = generateZodForProperty(
      "example.shell.plugins",
      entry("example.shell", { type: "array" }),
    );
    expect(result).toBe("z.array(z.unknown())");
  });

  it("generates nested object/array schemas", () => {
    const result = generateZodForProperty(
      "example.shell.layout",
      entry("example.shell", {
        type: "object",
        properties: {
          panels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        },
      }),
    );
    expect(result).toBe('z.object({ "panels": z.array(z.object({ "id": z.string() })) })');
  });

  it("generates integer as z.number().int()", () => {
    const result = generateZodForProperty(
      "example.map.grid",
      entry("example.map", { type: "integer", minimum: 1, maximum: 9 }),
    );
    expect(result).toBe("z.number().int().min(1).max(9)");
  });

  it("uses first type for union type arrays in zod generation", () => {
    const result = generateZodForProperty(
      "example.map.optionalGrid",
      entry("example.map", { type: ["integer", "null"], default: 3 }),
    );
    expect(result).toBe("z.number().int().default(3)");
  });

  it("generates z.enum([...]) for string with enum", () => {
    const result = generateZodForProperty(
      "example.shell.theme",
      entry("example.shell", { type: "string", enum: ["dark", "light"] }),
    );
    expect(result).toBe('z.enum(["dark", "light"])');
  });

  it("chains .default() for default values", () => {
    const result = generateZodForProperty(
      "example.shell.theme",
      entry("example.shell", { type: "string", default: "dark" }),
    );
    expect(result).toBe('z.string().default("dark")');
  });

  it("chains min, max, and default for number type", () => {
    const result = generateZodForProperty(
      "example.map.zoom",
      entry("example.map", { type: "number", minimum: 1, maximum: 20, default: 5 }),
    );
    expect(result).toBe("z.number().min(1).max(20).default(5)");
  });
});

describe("generateZodSchemaSource", () => {
  it("produces valid header with import", () => {
    const schemas = new Map();
    schemas.set("example.shell.theme", {
      ownerId: "example.shell",
      fullyQualifiedKey: "example.shell.theme",
      schema: { type: "string", default: "dark" },
    });

    const source = generateZodSchemaSource(schemas);
    expect(source.startsWith('import { z } from "zod";')).toBeTruthy();
  });

  it("produces configSchemas record", () => {
    const schemas = new Map();
    schemas.set("example.shell.theme", {
      ownerId: "example.shell",
      fullyQualifiedKey: "example.shell.theme",
      schema: { type: "string", default: "dark" },
    });
    schemas.set("example.map.zoom", {
      ownerId: "example.map",
      fullyQualifiedKey: "example.map.zoom",
      schema: { type: "number", minimum: 1, maximum: 20 },
    });

    const source = generateZodSchemaSource(schemas);
    expect(source.includes("export const configSchemas = {")).toBeTruthy();
    expect(source.includes('"example.shell.theme": example_shell_theme,')).toBeTruthy();
    expect(source.includes('"example.map.zoom": example_map_zoom,')).toBeTruthy();
    expect(source.includes("} as const;")).toBeTruthy();
  });

  it("produces individual exports with correct identifiers", () => {
    const schemas = new Map();
    schemas.set("example.shell.theme", {
      ownerId: "example.shell",
      fullyQualifiedKey: "example.shell.theme",
      schema: { type: "string", default: "dark" },
    });

    const source = generateZodSchemaSource(schemas);
    expect(source.includes('export const example_shell_theme = z.string().default("dark");')).toBeTruthy();
  });

  it("handles empty schemas map", () => {
    const source = generateZodSchemaSource(new Map());
    expect(source.includes('import { z } from "zod";')).toBeTruthy();
    expect(source.includes("export const configSchemas = {")).toBeTruthy();
    expect(source.includes("} as const;")).toBeTruthy();
  });
});
