// Zod schema generator — produces TypeScript source strings from schema entries

import type { ConfigurationSchemaEntry } from "./schema-generator-types";

type PropertySchema = ConfigurationSchemaEntry["schema"];

function isPropertySchema(
  value: PropertySchema | ReadonlyArray<PropertySchema>,
): value is PropertySchema {
  return !Array.isArray(value);
}

/**
 * Converts a dot-delimited config key to a valid JS identifier.
 * Replaces dots and hyphens with underscores.
 */
export function sanitizeKeyToIdentifier(key: string): string {
  return key.replace(/[.-]/g, "_");
}

/**
 * Generate a Zod expression string for a single config property.
 */
export function generateZodForProperty(
  _key: string,
  entry: ConfigurationSchemaEntry,
): string {
  return generateZodExpression(entry.schema);
}

function generateZodExpression(schema: PropertySchema): string {
  const parts: string[] = [];
  const schemaType = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  // Handle string enums specially — z.enum([...]) instead of z.string()
  if (
    schemaType === "string" &&
    schema.enum !== undefined &&
    schema.enum.length > 0
  ) {
    const enumValues = schema.enum
      .map((v: unknown) => JSON.stringify(v))
      .join(", ");
    parts.push(`z.enum([${enumValues}])`);
  } else {
    // Base type
    switch (schemaType) {
      case "number":
        parts.push("z.number()");
        break;
      case "integer":
        parts.push("z.number().int()");
        break;
      case "boolean":
        parts.push("z.boolean()");
        break;
      case "object":
        if (schema.properties !== undefined) {
          const shape = Object.entries(schema.properties)
            .map(
              ([key, value]) =>
                `${JSON.stringify(key)}: ${generateZodExpression(value)}`,
            )
            .join(", ");
          parts.push(`z.object({ ${shape} })`);
        } else if (schema.additionalProperties !== false) {
          if (
            schema.additionalProperties !== undefined &&
            schema.additionalProperties !== true
          ) {
            parts.push(
              `z.record(z.string(), ${generateZodExpression(schema.additionalProperties)})`,
            );
          } else {
            parts.push("z.record(z.string(), z.unknown())");
          }
        } else {
          parts.push("z.object({}).strict()");
        }
        break;
      case "array":
        if (schema.items !== undefined) {
          const itemsSchema = schema.items;
          if (isPropertySchema(itemsSchema)) {
            parts.push(`z.array(${generateZodExpression(itemsSchema)})`);
          } else {
            parts.push("z.array(z.unknown())");
          }
        } else {
          parts.push("z.array(z.unknown())");
        }
        break;
      case "null":
        parts.push("z.null()");
        break;
      default:
        parts.push("z.string()");
        break;
    }
  }

  // Chain constraints for number types
  if (schemaType === "number" || schemaType === "integer") {
    if (schema.minimum !== undefined) {
      parts.push(`.min(${schema.minimum})`);
    }
    if (schema.maximum !== undefined) {
      parts.push(`.max(${schema.maximum})`);
    }
  }

  // Default value
  if (schema.default !== undefined) {
    parts.push(`.default(${JSON.stringify(schema.default)})`);
  }

  return parts.join("");
}

/**
 * Generate a complete TypeScript source file with Zod schema definitions.
 */
export function generateZodSchemaSource(
  schemas: ReadonlyMap<string, ConfigurationSchemaEntry>,
): string {
  const lines: string[] = [];

  lines.push('import { z } from "zod";');
  lines.push("");

  const entries: Array<{
    identifier: string;
    key: string;
    expression: string;
  }> = [];

  for (const [key, entry] of schemas) {
    const identifier = sanitizeKeyToIdentifier(key);
    const expression = generateZodForProperty(key, entry);
    entries.push({ identifier, key, expression });
    lines.push(`export const ${identifier} = ${expression};`);
  }

  lines.push("");
  lines.push("export const configSchemas = {");
  for (const { identifier, key } of entries) {
    lines.push(`  ${JSON.stringify(key)}: ${identifier},`);
  }
  lines.push("} as const;");
  lines.push("");

  return lines.join("\n");
}
