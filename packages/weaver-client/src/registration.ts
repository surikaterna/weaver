import type {
  ConfigurationJsonSchemaType,
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
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

interface ZodTraversalContext {
  readonly activeSchemas: Set<unknown>;
  depth: number;
}

interface InferredZodType {
  readonly jsonType: ConfigurationPropertySchema;
  readonly isOptional: boolean;
}

const MAX_ZOD_TRAVERSAL_DEPTH = 100;

/**
 * Convert a Zod schema shape to a simplified JSON Schema representation.
 * Handles common types via duck-typing on Zod 4 internals.
 */
export function zodShapeToJsonSchema(
  shape: ZodRawShape,
): ObjectConfigurationPropertySchema {
  return shapeToJsonSchema(shape, { activeSchemas: new Set(), depth: 0 });
}

function shapeToJsonSchema(
  shape: Readonly<Record<string, unknown>>,
  context: ZodTraversalContext,
): ObjectConfigurationPropertySchema {
  const properties: Record<string, ConfigurationPropertySchema> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { jsonType, isOptional } = inferZodType(fieldSchema, context);
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

function inferZodType(
  schema: unknown,
  context: ZodTraversalContext,
): InferredZodType {
  return visitZodSchema(schema, context, (def) => {
    const typeName = getDefinitionType(def);
    if (typeName === "optional" || typeName === "nullable") {
      return inferWrappedType(def, typeName, context);
    }
    return { jsonType: inferJsonType(def, context), isOptional: false };
  });
}

function inferJsonType(
  def: Record<string, unknown>,
  context: ZodTraversalContext,
): ConfigurationPropertySchema {
  const typeName = getDefinitionType(def);
  if (typeName === "string") return { type: "string" };
  if (typeName === "number" || typeName === "float") return { type: "number" };
  if (typeName === "int") return { type: "integer" };
  if (typeName === "boolean") return { type: "boolean" };
  if (typeName === "array") return { type: "array" };
  if (typeName === "object") return inferObjectType(def, context);
  if (typeName === "enum") return inferEnumType(def);
  if (typeName === "literal") return inferLiteralType(def);

  throw new Error(`Unsupported Zod schema type "${typeName}"`);
}

function visitZodSchema<T>(
  schema: unknown,
  context: ZodTraversalContext,
  visit: (def: Record<string, unknown>) => T,
): T {
  if (context.depth >= MAX_ZOD_TRAVERSAL_DEPTH) {
    throw new Error("Zod schema traversal depth exceeds 100");
  }
  if (context.activeSchemas.has(schema)) {
    throw new Error("Cyclic Zod schema traversal");
  }
  context.activeSchemas.add(schema);
  context.depth++;
  try {
    return visit(getZodDef(schema));
  } finally {
    context.depth--;
    context.activeSchemas.delete(schema);
  }
}

function inferWrappedType(
  def: Record<string, unknown>,
  typeName: "optional" | "nullable",
  context: ZodTraversalContext,
): InferredZodType {
  if (!("innerType" in def)) {
    throw new Error(`Malformed Zod ${typeName} wrapper`);
  }
  const inner = inferZodType(def.innerType, context);
  if (typeName === "optional") return { ...inner, isOptional: true };
  return { ...inner, jsonType: makeNullable(inner.jsonType) };
}

function inferObjectType(
  def: Record<string, unknown>,
  context: ZodTraversalContext,
): ConfigurationPropertySchema {
  const shape = def.shape;
  if (!isRecord(shape)) throw new Error("Malformed Zod object shape");
  return shapeToJsonSchema(shape, context);
}

function inferEnumType(
  def: Record<string, unknown>,
): ConfigurationPropertySchema {
  const entries = def.entries;
  if (!isRecord(entries)) throw new Error("Malformed Zod enum entries");
  const values = Object.values(entries);
  if (values.length === 0) throw new Error("Zod enum must not be empty");
  return { type: literalSchemaType(values), enum: values };
}

function inferLiteralType(
  def: Record<string, unknown>,
): ConfigurationPropertySchema {
  const values = def.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Malformed Zod literal values");
  }
  const type = literalSchemaType(values);
  if (values.length === 1) return { type, const: values[0] };
  return { type, enum: values };
}

function literalSchemaType(
  values: ReadonlyArray<unknown>,
): ConfigurationPropertySchema["type"] {
  const types = [...new Set(values.map(jsonSchemaTypeForLiteral))];
  const [first] = types;
  if (!first) throw new Error("Zod literal values must not be empty");
  return types.length === 1 ? first : types;
}

function jsonSchemaTypeForLiteral(value: unknown): ConfigurationJsonSchemaType {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? "integer" : "number";
  }
  throw new Error("Unsupported Zod literal value");
}

function makeNullable(
  schema: ConfigurationPropertySchema,
): ConfigurationPropertySchema {
  const currentTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (currentTypes.includes("null")) return schema;
  const type: ReadonlyArray<ConfigurationJsonSchemaType> = [
    ...currentTypes,
    "null",
  ];
  if (Object.hasOwn(schema, "const")) {
    const { const: literalValue, ...withoutConst } = schema;
    return { ...withoutConst, type, enum: [literalValue, null] };
  }
  if (schema.enum) return { ...schema, type, enum: [...schema.enum, null] };
  return { ...schema, type };
}

function getZodDef(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) throw new Error("Malformed Zod schema object");
  const zodInternals = schema._zod;
  if (!isRecord(zodInternals)) {
    throw new Error("Unsupported Zod 4 schema internals");
  }
  if (!isRecord(zodInternals.def)) {
    throw new Error("Malformed Zod 4 schema definition");
  }
  return zodInternals.def;
}

function getDefinitionType(def: Record<string, unknown>): string {
  if (typeof def.type !== "string") {
    throw new Error("Malformed Zod schema type");
  }
  return def.type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
