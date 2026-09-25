import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  allowsType,
  compileSchemaPattern,
  describeTypes,
  getArrayIndex,
  isSchemaArray,
  type MemberSchemaResult,
  makeError,
  type SchemaValidationError,
  type SchemaValidationPathSegment,
  type ValidationContext,
  type ValidationErrorPath,
} from "./schema-validation-support";

export function resolveMemberSchemas(
  schema: ConfigurationPropertySchema,
  path: readonly SchemaValidationPathSegment[],
  basePath: readonly SchemaValidationPathSegment[],
): MemberSchemaResult {
  let candidates: ConfigurationPropertySchema[] = [schema];
  const errors: SchemaValidationError[] = [];
  const prefix = [...basePath];

  for (const segment of path) {
    if (candidates.length === 0) return { schemas: [], errors };
    const next = candidates.flatMap((candidate) =>
      resolveNextSchemas(candidate, segment, prefix, errors),
    );
    if (errors.length > 0) return { schemas: [], errors };
    candidates = next;
    prefix.push(segment);
  }

  return { schemas: candidates, errors };
}

export function collectMemberSchemas(
  schema: ConfigurationPropertySchema,
  key: string,
  path: ValidationErrorPath,
  context: ValidationContext,
): ConfigurationPropertySchema[] {
  const schemas: ConfigurationPropertySchema[] = [];
  const properties = Object.hasOwn(schema, "properties")
    ? schema.properties
    : undefined;
  const declared =
    properties !== undefined && Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
  if (declared !== undefined) schemas.push(declared);
  const patterns = Object.hasOwn(schema, "patternProperties")
    ? schema.patternProperties
    : undefined;
  if (patterns !== undefined) {
    collectPatternSchemas(patterns, key, path, context, schemas);
  }
  return schemas;
}

export function itemSchema(
  schema: ConfigurationPropertySchema,
  index: number,
): ConfigurationPropertySchema | undefined {
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  if (items === undefined) return undefined;
  return isSchemaArray(items) ? items[index] : items;
}

function resolveNextSchemas(
  schema: ConfigurationPropertySchema,
  segment: SchemaValidationPathSegment,
  path: readonly SchemaValidationPathSegment[],
  errors: SchemaValidationError[],
): ConfigurationPropertySchema[] {
  const resolved: ConfigurationPropertySchema[] = [];
  for (const projected of directAndAllOfSchemas(schema)) {
    resolved.push(...resolveDirectSchema(projected, segment, path, errors));
    if (errors.length > 0) return [];
  }
  return resolved;
}

function resolveDirectSchema(
  schema: ConfigurationPropertySchema,
  segment: SchemaValidationPathSegment,
  path: readonly SchemaValidationPathSegment[],
  errors: SchemaValidationError[],
): ConfigurationPropertySchema[] {
  if (allowsType(schema, "object")) {
    return resolveObjectMemberSchema(schema, String(segment), path, errors);
  }
  if (allowsType(schema, "array")) {
    return resolveArrayMemberSchema(schema, segment, path, errors);
  }
  errors.push(
    makeError(
      "invalid-path",
      [...path, segment],
      `Cannot address member on ${describeTypes(schema)}`,
    ),
  );
  return [];
}

function directAndAllOfSchemas(
  schema: ConfigurationPropertySchema,
): readonly ConfigurationPropertySchema[] {
  const projected: ConfigurationPropertySchema[] = [];
  const pending = [schema];
  const completed = new WeakSet<ConfigurationPropertySchema>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (completed.has(current)) continue;
    completed.add(current);
    projected.push(current);
    const branches = Object.hasOwn(current, "allOf")
      ? current.allOf
      : undefined;
    if (!Array.isArray(branches)) continue;
    for (let index = branches.length - 1; index >= 0; index--) {
      const branch = branches[index];
      if (branch !== undefined) pending.push(branch);
    }
  }
  return projected;
}

function resolveObjectMemberSchema(
  schema: ConfigurationPropertySchema,
  key: string,
  path: readonly SchemaValidationPathSegment[],
  errors: SchemaValidationError[],
): ConfigurationPropertySchema[] {
  const context: ValidationContext = { mode: "partial", errors };
  const schemas = collectMemberSchemas(schema, key, path, context);
  if (schemas.length > 0) return schemas;
  const additional = Object.hasOwn(schema, "additionalProperties")
    ? schema.additionalProperties
    : undefined;
  if (additional === true) return [];
  if (additional === undefined || additional === false) {
    errors.push(
      makeError(
        "unknown-property",
        [...path, key],
        `Unknown property "${key}" is not allowed`,
      ),
    );
    return [];
  }
  return [additional];
}

function resolveArrayMemberSchema(
  schema: ConfigurationPropertySchema,
  segment: SchemaValidationPathSegment,
  path: readonly SchemaValidationPathSegment[],
  errors: SchemaValidationError[],
): ConfigurationPropertySchema[] {
  const index = getArrayIndex(segment);
  if (index === undefined) {
    errors.push(
      makeError(
        "invalid-path",
        [...path, segment],
        "Array member path must use a canonical index between 0 and 4294967294",
      ),
    );
    return [];
  }
  const items = Object.hasOwn(schema, "items") ? schema.items : undefined;
  if (items === undefined) return [];
  if (!isSchemaArray(items)) return [items];
  const item = items[index];
  return item === undefined ? [] : [item];
}

function collectPatternSchemas(
  patterns: Readonly<Record<string, ConfigurationPropertySchema>>,
  key: string,
  path: ValidationErrorPath,
  context: ValidationContext,
  schemas: ConfigurationPropertySchema[],
): void {
  for (const [pattern, nestedSchema] of Object.entries(patterns)) {
    const regex = compileSchemaPattern(pattern, path, context);
    if (regex?.test(key) === true) schemas.push(nestedSchema);
  }
}
