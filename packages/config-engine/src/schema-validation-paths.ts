import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import { rejectUnsupportedComposition } from "./schema-validation-composition";
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
  const properties = schema.properties;
  const declared =
    properties !== undefined && Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
  if (declared !== undefined) schemas.push(declared);
  schemas.push(...patternSchemas(schema, key, path, context));
  return schemas;
}

function resolveNextSchemas(
  schema: ConfigurationPropertySchema,
  segment: SchemaValidationPathSegment,
  path: readonly SchemaValidationPathSegment[],
  errors: SchemaValidationError[],
): ConfigurationPropertySchema[] {
  const context: ValidationContext = { mode: "partial", errors };
  if (rejectUnsupportedComposition(schema, path, context)) {
    return [];
  }

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

function resolveObjectMemberSchema(
  schema: ConfigurationPropertySchema,
  key: string,
  path: readonly SchemaValidationPathSegment[],
  errors: SchemaValidationError[],
): ConfigurationPropertySchema[] {
  const context: ValidationContext = { mode: "partial", errors };
  const schemas = collectMemberSchemas(schema, key, path, context);
  if (schemas.length > 0) return schemas;
  if (schema.additionalProperties === true) return [];
  if (
    schema.additionalProperties === undefined ||
    schema.additionalProperties === false
  ) {
    errors.push(
      makeError(
        "unknown-property",
        [...path, key],
        `Unknown property "${key}" is not allowed`,
      ),
    );
    return [];
  }
  return [schema.additionalProperties];
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
  const items = schema.items;
  if (items === undefined) return [];
  if (!isSchemaArray(items)) return [items];
  const item = items[index];
  return item === undefined ? [] : [item];
}

function patternSchemas(
  schema: ConfigurationPropertySchema,
  key: string,
  path: ValidationErrorPath,
  context: ValidationContext,
): ConfigurationPropertySchema[] {
  const entries = Object.entries(schema.patternProperties ?? {});
  return entries.flatMap(([pattern, nestedSchema]) => {
    const regex = compileSchemaPattern(pattern, path, context);
    return regex?.test(key) === true ? [nestedSchema] : [];
  });
}
