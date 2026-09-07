// JSON Schema generator — converts configuration schema entries to JSON Schema draft-07

import type { ConfigurationSchemaEntry } from "./schema-generator-types";

type PropertySchema = ConfigurationSchemaEntry["schema"];

function isPropertySchema(
  value: PropertySchema | ReadonlyArray<PropertySchema>,
): value is PropertySchema {
  return !Array.isArray(value);
}

export interface JsonSchemaDocument {
  $schema: string;
  title: string;
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  additionalProperties: boolean;
}

export interface JsonSchemaProperty {
  type?: string | string[] | undefined;
  title?: string | undefined;
  description?: string | undefined;
  default?: unknown | undefined;
  examples?: unknown[] | undefined;
  const?: unknown | undefined;
  enum?: unknown[] | undefined;
  format?: string | undefined;
  pattern?: string | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  multipleOf?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  exclusiveMaximum?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  uniqueItems?: boolean | undefined;
  minProperties?: number | undefined;
  maxProperties?: number | undefined;
  required?: string[] | undefined;
  properties?: Record<string, JsonSchemaProperty> | undefined;
  patternProperties?: Record<string, JsonSchemaProperty> | undefined;
  additionalProperties?: boolean | JsonSchemaProperty | undefined;
  items?: JsonSchemaProperty | JsonSchemaProperty[] | undefined;
  oneOf?: JsonSchemaProperty[] | undefined;
  anyOf?: JsonSchemaProperty[] | undefined;
  allOf?: JsonSchemaProperty[] | undefined;
  not?: JsonSchemaProperty | undefined;
  "x-weaver"?: Record<string, unknown> | undefined;
}

const TYPE_MAP: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null",
};

function mapType(type: PropertySchema["type"]): string | string[] {
  if (typeof type === "string") {
    return TYPE_MAP[type] ?? type;
  }
  return [...type].map((value) => TYPE_MAP[value] ?? value);
}

function copyScalarConstraints(
  schema: PropertySchema,
  prop: JsonSchemaProperty,
): void {
  if (schema.title !== undefined) prop.title = schema.title;
  if (schema.description !== undefined) prop.description = schema.description;
  if (schema.default !== undefined) prop.default = schema.default;
  if (schema.examples !== undefined) prop.examples = [...schema.examples];
  if (schema.const !== undefined) prop.const = schema.const;
  if (schema.enum !== undefined) prop.enum = [...schema.enum];
  if (schema.format !== undefined) prop.format = schema.format;
  if (schema.pattern !== undefined) prop.pattern = schema.pattern;
  if (schema.minLength !== undefined) prop.minLength = schema.minLength;
  if (schema.maxLength !== undefined) prop.maxLength = schema.maxLength;
  if (schema.multipleOf !== undefined) prop.multipleOf = schema.multipleOf;
  if (schema.minimum !== undefined) prop.minimum = schema.minimum;
  if (schema.maximum !== undefined) prop.maximum = schema.maximum;
  if (schema.exclusiveMinimum !== undefined)
    prop.exclusiveMinimum = schema.exclusiveMinimum;
  if (schema.exclusiveMaximum !== undefined)
    prop.exclusiveMaximum = schema.exclusiveMaximum;
  if (schema.minItems !== undefined) prop.minItems = schema.minItems;
  if (schema.maxItems !== undefined) prop.maxItems = schema.maxItems;
  if (schema.uniqueItems !== undefined) prop.uniqueItems = schema.uniqueItems;
  if (schema.minProperties !== undefined)
    prop.minProperties = schema.minProperties;
  if (schema.maxProperties !== undefined)
    prop.maxProperties = schema.maxProperties;
  if (schema.required !== undefined) prop.required = [...schema.required];
}

function copyCompositeConstraints(
  schema: PropertySchema,
  prop: JsonSchemaProperty,
): void {
  if (schema.properties !== undefined) {
    const mapped: Record<string, JsonSchemaProperty> = {};
    for (const [key, nestedSchema] of Object.entries(schema.properties)) {
      mapped[key] = generateNestedPropertySchema(nestedSchema);
    }
    prop.properties = mapped;
  }

  if (schema.patternProperties !== undefined) {
    const mapped: Record<string, JsonSchemaProperty> = {};
    for (const [key, nestedSchema] of Object.entries(
      schema.patternProperties,
    )) {
      mapped[key] = generateNestedPropertySchema(nestedSchema);
    }
    prop.patternProperties = mapped;
  }

  if (schema.additionalProperties !== undefined) {
    prop.additionalProperties =
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : generateNestedPropertySchema(schema.additionalProperties);
  }

  if (schema.items !== undefined) {
    const itemSchema = schema.items;
    prop.items = isPropertySchema(itemSchema)
      ? generateNestedPropertySchema(itemSchema)
      : itemSchema.map((item: PropertySchema) =>
          generateNestedPropertySchema(item),
        );
  }

  if (schema.oneOf !== undefined) {
    prop.oneOf = schema.oneOf.map((item: PropertySchema) =>
      generateNestedPropertySchema(item),
    );
  }
  if (schema.anyOf !== undefined) {
    prop.anyOf = schema.anyOf.map((item: PropertySchema) =>
      generateNestedPropertySchema(item),
    );
  }
  if (schema.allOf !== undefined) {
    prop.allOf = schema.allOf.map((item: PropertySchema) =>
      generateNestedPropertySchema(item),
    );
  }
  if (schema.not !== undefined) {
    prop.not = generateNestedPropertySchema(schema.not);
  }
}

function generateNestedPropertySchema(
  schema: PropertySchema,
): JsonSchemaProperty {
  const prop: JsonSchemaProperty = {
    type: mapType(schema.type),
  };

  copyScalarConstraints(schema, prop);
  copyCompositeConstraints(schema, prop);

  return prop;
}

/**
 * Generate a single JSON Schema property from a configuration schema entry.
 */
export function generateSinglePropertySchema(
  _key: string,
  entry: ConfigurationSchemaEntry,
): JsonSchemaProperty {
  const { schema } = entry;
  const prop = generateNestedPropertySchema(schema);

  const xWeaver: Record<string, unknown> = {};

  if (schema["x-weaver"]?.changePolicy !== undefined) {
    xWeaver.changePolicy = schema["x-weaver"].changePolicy;
  }
  if (schema["x-weaver"]?.visibility !== undefined) {
    xWeaver.visibility = schema["x-weaver"].visibility;
  }
  if (schema["x-weaver"]?.reloadBehavior !== undefined) {
    xWeaver.reloadBehavior = schema["x-weaver"].reloadBehavior;
  }
  if (schema["x-weaver"]?.sensitive !== undefined) {
    xWeaver.sensitive = schema["x-weaver"].sensitive;
  }
  if (schema["x-weaver"]?.maxOverrideLayer !== undefined) {
    xWeaver.maxOverrideLayer = schema["x-weaver"].maxOverrideLayer;
  }
  if (schema["x-weaver"]?.writeRestriction !== undefined) {
    xWeaver.writeRestriction = [...schema["x-weaver"].writeRestriction];
  }
  if (schema["x-weaver"]?.sessionMode !== undefined) {
    xWeaver.sessionMode = schema["x-weaver"].sessionMode;
  }
  if (schema["x-weaver"]?.expressionAllowed !== undefined) {
    xWeaver.expressionAllowed = schema["x-weaver"].expressionAllowed;
  }

  prop["x-weaver"] = xWeaver;

  return prop;
}

/**
 * Generate a complete JSON Schema document from composed schemas.
 */
export function generateJsonSchema(
  schemas: ReadonlyMap<string, ConfigurationSchemaEntry>,
  options?: { title?: string | undefined },
): JsonSchemaDocument {
  const properties: Record<string, JsonSchemaProperty> = {};

  for (const [key, entry] of schemas) {
    properties[key] = generateSinglePropertySchema(key, entry);
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: options?.title ?? "Weaver Configuration Schema",
    type: "object",
    properties,
    additionalProperties: false,
  };
}
