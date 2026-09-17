import {
  generateZodSchemaSource,
  generateZodForProperty,
  sanitizeKeyToIdentifier,
} from "../dist/zod-schema-generator.js";

/** @param {object} schema */
function entry(_source, schema) {
  return { schema };
}

describe("sanitizeKeyToIdentifier", () => {
  it("converts dots to underscores", () => {
    expect(sanitizeKeyToIdentifier("ghost.shell.theme")).toBe("ghost_shell_theme");
  });

  it("converts hyphens to underscores", () => {
    expect(sanitizeKeyToIdentifier("ghost.vessel-view.zoom")).toBe("ghost_vessel_view_zoom");
  });

  it("converts dots and hyphens together", () => {
    expect(sanitizeKeyToIdentifier("ghost.my-plugin.setting")).toBe("ghost_my_plugin_setting");
  });
});

describe("generateZodForProperty", () => {
  it("generates z.string() for string type", () => {
    const result = generateZodForProperty(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string" }),
    );
    expect(result).toBe("z.string()");
  });

  it("generates z.number() with min/max for number type", () => {
    const result = generateZodForProperty(
      "ghost.map.zoom",
      entry("ghost.map", { type: "number", minimum: 1, maximum: 20 }),
    );
    expect(result).toBe("z.number().min(1).max(20)");
  });

  it("generates z.boolean() for boolean type", () => {
    const result = generateZodForProperty(
      "ghost.shell.enabled",
      entry("ghost.shell", { type: "boolean" }),
    );
    expect(result).toBe("z.boolean()");
  });

  it("generates z.record for object type", () => {
    const result = generateZodForProperty(
      "ghost.shell.layout",
      entry("ghost.shell", { type: "object" }),
    );
    expect(result).toBe("z.record(z.string(), z.unknown())");
  });

  it("generates z.array for array type", () => {
    const result = generateZodForProperty(
      "ghost.shell.plugins",
      entry("ghost.shell", { type: "array" }),
    );
    expect(result).toBe("z.array(z.unknown())");
  });

  it("generates nested object/array schemas", () => {
    const result = generateZodForProperty(
      "ghost.shell.layout",
      entry("ghost.shell", {
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
      "ghost.map.grid",
      entry("ghost.map", { type: "integer", minimum: 1, maximum: 9 }),
    );
    expect(result).toBe("z.number().int().min(1).max(9)");
  });

  it("uses first type for union type arrays in zod generation", () => {
    const result = generateZodForProperty(
      "ghost.map.optionalGrid",
      entry("ghost.map", { type: ["integer", "null"], default: 3 }),
    );
    expect(result).toBe("z.number().int().default(3)");
  });

  it("generates z.enum([...]) for string with enum", () => {
    const result = generateZodForProperty(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string", enum: ["dark", "light"] }),
    );
    expect(result).toBe('z.enum(["dark", "light"])');
  });

  it("chains .default() for default values", () => {
    const result = generateZodForProperty(
      "ghost.shell.theme",
      entry("ghost.shell", { type: "string", default: "dark" }),
    );
    expect(result).toBe('z.string().default("dark")');
  });

  it("chains min, max, and default for number type", () => {
    const result = generateZodForProperty(
      "ghost.map.zoom",
      entry("ghost.map", { type: "number", minimum: 1, maximum: 20, default: 5 }),
    );
    expect(result).toBe("z.number().min(1).max(20).default(5)");
  });
});

describe("generateZodSchemaSource", () => {
  it("produces valid header with import", () => {
    const schemas = new Map();
    schemas.set("ghost.shell.theme", {
      schema: { type: "string", default: "dark" },
    });

    const source = generateZodSchemaSource(schemas);
    expect(source.startsWith('import { z } from "zod";')).toBeTruthy();
  });

  it("produces configSchemas record", () => {
    const schemas = new Map();
    schemas.set("ghost.shell.theme", {
      schema: { type: "string", default: "dark" },
    });
    schemas.set("ghost.map.zoom", {
      schema: { type: "number", minimum: 1, maximum: 20 },
    });

    const source = generateZodSchemaSource(schemas);
    expect(source.includes("export const configSchemas = {")).toBeTruthy();
    expect(source.includes('"ghost.shell.theme": ghost_shell_theme,')).toBeTruthy();
    expect(source.includes('"ghost.map.zoom": ghost_map_zoom,')).toBeTruthy();
    expect(source.includes("} as const;")).toBeTruthy();
  });

  it("produces individual exports with correct identifiers", () => {
    const schemas = new Map();
    schemas.set("ghost.shell.theme", {
      schema: { type: "string", default: "dark" },
    });

    const source = generateZodSchemaSource(schemas);
    expect(source.includes('export const ghost_shell_theme = z.string().default("dark");')).toBeTruthy();
  });

  it("handles empty schemas map", () => {
    const source = generateZodSchemaSource(new Map());
    expect(source.includes('import { z } from "zod";')).toBeTruthy();
    expect(source.includes("export const configSchemas = {")).toBeTruthy();
    expect(source.includes("} as const;")).toBeTruthy();
  });
});
