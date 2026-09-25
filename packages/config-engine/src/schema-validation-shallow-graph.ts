import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  hasComposition,
  isSupportedSchema,
} from "./schema-validation-composition";
import { collectConstraintRoots } from "./schema-validation-constraint-graph";
import { validateSchemaNode } from "./schema-validation-definitions";
import {
  addContextError,
  allowsType,
  isSchemaArray,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

export function hasOnlyTypeLeafChildren(
  schema: ConfigurationPropertySchema,
  leaves?: WeakSet<ConfigurationPropertySchema>,
): boolean {
  if (!mapHasOnlyTypeLeaves(schema, "properties", leaves)) return false;
  if (!mapHasOnlyTypeLeaves(schema, "patternProperties", leaves)) return false;
  const additional = Object.hasOwn(schema, "additionalProperties")
    ? schema.additionalProperties
    : undefined;
  if (
    additional !== undefined &&
    typeof additional !== "boolean" &&
    !isTypeLeafSchema(additional)
  ) {
    return false;
  }
  if (additional !== undefined && typeof additional !== "boolean") {
    leaves?.add(additional);
  }
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  if (items === undefined) return true;
  if (!isSchemaArray(items)) {
    const leaf = isTypeLeafSchema(items);
    if (leaf) leaves?.add(items);
    return leaf;
  }
  for (let index = 0; index < items.length; index++) {
    if (!Object.hasOwn(items, index) || !isTypeLeafSchema(items[index]))
      return false;
    const item = items[index];
    if (item !== undefined) leaves?.add(item);
  }
  return true;
}

export function hasSchemaChildren(
  schema: ConfigurationPropertySchema,
  composed: boolean,
): boolean {
  if (composed) return true;
  const properties = Object.hasOwn(schema, "properties")
    ? schema.properties
    : undefined;
  if (hasSchemaMapChildren(properties)) return true;
  const patterns = Object.hasOwn(schema, "patternProperties")
    ? schema.patternProperties
    : undefined;
  if (hasSchemaMapChildren(patterns)) return true;
  const additional = Object.hasOwn(schema, "additionalProperties")
    ? schema.additionalProperties
    : undefined;
  if (additional !== undefined && typeof additional !== "boolean") return true;
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  return items !== undefined && (!Array.isArray(items) || items.length > 0);
}

interface TerminalChild {
  readonly invalidMessage: string;
  readonly schema?: ConfigurationPropertySchema | undefined;
}

export interface TerminalChildrenInspection {
  readonly children: readonly TerminalChild[];
}

export function inspectTerminalChildren(
  schema: ConfigurationPropertySchema,
): TerminalChildrenInspection | undefined {
  const children: TerminalChild[] = [];
  collectTerminalMapChildren(schema, "properties", children);
  collectTerminalMapChildren(schema, "patternProperties", children);
  collectTerminalAdditionalChild(schema, children);
  collectTerminalItemChildren(schema, children);
  for (const child of children) {
    if (child.schema === undefined) continue;
    const composed = hasComposition(child.schema);
    if (composed || hasSchemaChildren(child.schema, composed)) return undefined;
  }
  return { children };
}

export function validateTerminalChildren(
  inspection: TerminalChildrenInspection,
  path: ValidationPath,
  context: ValidationContext,
  predicateScalars: WeakSet<ConfigurationPropertySchema>,
  constraintRoots: unknown[],
): boolean {
  for (const child of inspection.children) {
    if (child.schema === undefined) {
      return invalidSchema(path, context, child.invalidMessage);
    }
    if (
      !isTypeLeafSchema(child.schema) &&
      !validateSchemaNode(child.schema, path, context, isSupportedSchema, false)
    ) {
      return false;
    }
    if (isScalarSchema(child.schema)) predicateScalars.add(child.schema);
    collectConstraintRoots(child.schema, constraintRoots);
  }
  return true;
}

export function isScalarSchema(schema: ConfigurationPropertySchema): boolean {
  return !allowsType(schema, "object") && !allowsType(schema, "array");
}

function collectTerminalMapChildren(
  schema: ConfigurationPropertySchema,
  key: "properties" | "patternProperties",
  children: TerminalChild[],
): void {
  if (!Object.hasOwn(schema, key) || schema[key] === undefined) return;
  for (const [name, value] of Object.entries(schema[key])) {
    children.push(
      terminalChild(
        value,
        `${key} entry ${JSON.stringify(name)} must be a schema object with a supported non-empty type`,
      ),
    );
  }
}

function collectTerminalAdditionalChild(
  schema: ConfigurationPropertySchema,
  children: TerminalChild[],
): void {
  const additional = Object.hasOwn(schema, "additionalProperties")
    ? schema.additionalProperties
    : undefined;
  if (additional !== undefined && typeof additional !== "boolean") {
    children.push(
      terminalChild(
        additional,
        "additionalProperties must be a boolean or schema object with a supported non-empty type",
      ),
    );
  }
}

function collectTerminalItemChildren(
  schema: ConfigurationPropertySchema,
  children: TerminalChild[],
): void {
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  if (items === undefined) return;
  if (!Array.isArray(items)) {
    children.push(
      terminalChild(
        items,
        "items must be a schema object or dense array of schema objects with supported non-empty types",
      ),
    );
    return;
  }
  for (let index = 0; index < items.length; index++) {
    const value = Object.hasOwn(items, index) ? items[index] : undefined;
    children.push(
      terminalChild(
        value,
        `items entry ${String(index)} must be a schema object with a supported non-empty type`,
      ),
    );
  }
}

function terminalChild(value: unknown, invalidMessage: string): TerminalChild {
  return isSupportedSchema(value)
    ? { schema: value, invalidMessage }
    : { invalidMessage };
}

function hasSchemaMapChildren(
  map: Readonly<Record<string, ConfigurationPropertySchema>> | undefined,
): boolean {
  return map !== undefined && Object.keys(map).length > 0;
}

export function validateTypeLeafChildren(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
  supportsSchema: (value: unknown) => boolean,
): boolean {
  if (!validateMapLeaves(schema, "properties", path, context, supportsSchema))
    return false;
  if (
    !validateMapLeaves(
      schema,
      "patternProperties",
      path,
      context,
      supportsSchema,
    )
  )
    return false;
  const additional = Object.hasOwn(schema, "additionalProperties")
    ? schema.additionalProperties
    : undefined;
  if (
    additional !== undefined &&
    typeof additional !== "boolean" &&
    !supportsSchema(additional)
  ) {
    return invalidSchema(
      path,
      context,
      "additionalProperties must be a boolean or schema object with a supported non-empty type",
    );
  }
  return validateItemLeaves(schema, path, context, supportsSchema);
}

function mapHasOnlyTypeLeaves(
  schema: ConfigurationPropertySchema,
  key: "properties" | "patternProperties",
  leaves?: WeakSet<ConfigurationPropertySchema>,
): boolean {
  if (!Object.hasOwn(schema, key) || schema[key] === undefined) return true;
  for (const child of Object.values(schema[key])) {
    if (!isTypeLeafSchema(child)) return false;
    leaves?.add(child);
  }
  return true;
}

export function isTypeLeafSchema(
  value: unknown,
): value is ConfigurationPropertySchema {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.getOwnPropertyNames(value);
  return keys.length === 1 && keys[0] === "type";
}

function validateMapLeaves(
  schema: ConfigurationPropertySchema,
  key: "properties" | "patternProperties",
  path: ValidationPath,
  context: ValidationContext,
  supportsSchema: (value: unknown) => boolean,
): boolean {
  if (!Object.hasOwn(schema, key)) return true;
  const map = schema[key];
  if (map === undefined) return true;
  for (const [name, child] of Object.entries(map)) {
    if (!supportsSchema(child)) {
      return invalidSchema(
        path,
        context,
        `${key} entry ${JSON.stringify(name)} must be a schema object with a supported non-empty type`,
      );
    }
  }
  return true;
}

function validateItemLeaves(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
  supportsSchema: (value: unknown) => boolean,
): boolean {
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  if (items === undefined) return true;
  if (!isSchemaArray(items)) {
    if (supportsSchema(items)) return true;
    return invalidSchema(
      path,
      context,
      "items must be a schema object or dense array of schema objects with supported non-empty types",
    );
  }
  for (let index = 0; index < items.length; index++) {
    if (!Object.hasOwn(items, index) || !supportsSchema(items[index])) {
      return invalidSchema(
        path,
        context,
        `items entry ${String(index)} must be a schema object with a supported non-empty type`,
      );
    }
  }
  return true;
}

function invalidSchema(
  path: ValidationPath,
  context: ValidationContext,
  message: string,
): false {
  addContextError(context, "invalid-schema", path, { message });
  return false;
}
