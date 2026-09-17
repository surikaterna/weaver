import type {
  ConfigurationPropertySchema,
  WeaverError,
} from "@weaver-conf/config-types";
import type { ZodRawShape } from "zod";
import type { NamespaceDefinition } from "./namespace";
import type { WeaverTransport } from "./transport";

/** Result of registering namespace schemas with the server. */
export interface SchemaRegistrationResult {
  registered: string[];
  skipped: string[];
  errors: Array<{ namespace: string; error: string }>;
}

/**
 * Convert a Zod schema shape to a simplified JSON Schema representation.
 * Handles common types via duck-typing on Zod 4 internals.
 */
export function zodShapeToJsonSchema(
  shape: ZodRawShape,
): ConfigurationPropertySchema {
  const properties: Record<string, ConfigurationPropertySchema> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { jsonType, isOptional } = inferZodType(fieldSchema);
    properties[key] = jsonType;
    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function inferZodType(schema: unknown): {
  jsonType: ConfigurationPropertySchema;
  isOptional: boolean;
} {
  const { current, isOptional } = unwrapOptionalSchema(schema);
  const innerDef = getZodDef(current);
  const typeName = innerDef?.type as string | undefined; // SAFETY: Zod def.type is always string if present

  if (typeName === "string")
    return { jsonType: { type: "string" }, isOptional };
  if (typeName === "number" || typeName === "float")
    return { jsonType: { type: "number" }, isOptional };
  if (typeName === "int") return { jsonType: { type: "integer" }, isOptional };
  if (typeName === "boolean")
    return { jsonType: { type: "boolean" }, isOptional };
  if (typeName === "array") return { jsonType: { type: "array" }, isOptional };
  if (typeName === "object") return inferObjectType(innerDef, isOptional);
  if (typeName === "enum") return inferEnumType(innerDef, isOptional);
  if (typeName === "literal") return inferLiteralType(innerDef, isOptional);

  return { jsonType: { type: "object" }, isOptional };
}

function unwrapOptionalSchema(schema: unknown): {
  current: Record<string, unknown>;
  isOptional: boolean;
} {
  let current = schema as Record<string, unknown>; // SAFETY: Zod schemas are object-like values
  const def = getZodDef(current);
  if (!(def && (def.type === "optional" || def.type === "nullable"))) {
    return { current, isOptional: false };
  }

  const inner = def.innerType;
  if (inner) current = inner as Record<string, unknown>; // SAFETY: Zod innerType is a schema object
  return { current, isOptional: true };
}

function inferObjectType(
  def: Record<string, unknown> | undefined,
  isOptional: boolean,
): { jsonType: ConfigurationPropertySchema; isOptional: boolean } {
  const shape = def?.shape;
  if (shape && typeof shape === "object") {
    return { jsonType: zodShapeToJsonSchema(shape as ZodRawShape), isOptional }; // SAFETY: confirmed shape is object
  }
  return { jsonType: { type: "object" }, isOptional };
}

function inferEnumType(
  def: Record<string, unknown> | undefined,
  isOptional: boolean,
): { jsonType: ConfigurationPropertySchema; isOptional: boolean } {
  const entries = def?.entries;
  if (entries && typeof entries === "object") {
    return {
      jsonType: { type: "string", enum: Object.keys(entries) },
      isOptional,
    };
  }
  return { jsonType: { type: "string" }, isOptional };
}

function inferLiteralType(
  def: Record<string, unknown> | undefined,
  isOptional: boolean,
): { jsonType: ConfigurationPropertySchema; isOptional: boolean } {
  const value = def?.value;
  return {
    jsonType: { type: getJsonSchemaType(value), const: value },
    isOptional,
  };
}

function getJsonSchemaType(
  value: unknown,
): ConfigurationPropertySchema["type"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function getZodDef(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // SAFETY: accessing Zod 4 internal structure
  const _zod = schema._zod as Record<string, unknown> | undefined;
  if (_zod?.def) return _zod.def as Record<string, unknown>; // SAFETY: Zod def is always an object
  // Zod 3 fallback: schema._def
  const _def = schema._def as Record<string, unknown> | undefined; // SAFETY: Zod 3 internal structure
  if (_def?.type) return _def;
  return undefined;
}

export async function registerNamespaces(
  definitions: ReadonlyArray<NamespaceDefinition>,
  transport: WeaverTransport,
): Promise<SchemaRegistrationResult> {
  const result: SchemaRegistrationResult = {
    registered: [],
    skipped: [],
    errors: [],
  };

  if (!transport.registerSchema) {
    result.skipped = definitions.map((d) => d.prefix);
    return result;
  }

  for (const def of definitions) {
    try {
      const jsonSchema = zodShapeToJsonSchema(def.schema.shape);
      const response = await transport.registerSchema({
        serviceId: def.prefix,
        environment: "default",
        owner: { name: def.prefix, contact: "unknown" },
        schema: jsonSchema,
        fragmentSlots: [],
      });
      if (response.success === false) {
        result.errors.push({
          namespace: def.prefix,
          error: schemaRegistrationErrorMessage(response.error),
        });
        continue;
      }
      result.registered.push(def.prefix);
    } catch (e) {
      result.errors.push({
        namespace: def.prefix,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

function schemaRegistrationErrorMessage(
  error: WeaverError | undefined,
): string {
  return error?.message ?? "Schema registration failed";
}
