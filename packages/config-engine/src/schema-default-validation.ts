import type {
  ConfigurationPropertySchema,
  SchemaValidationError,
  SchemaValidationResult,
} from "@weaver-conf/config-types";
import { containsRegistrationDefaultMarker } from "@weaver-conf/config-types";
import { materializeConfigurationDefaultsForSchemas } from "./schema-defaults";
import { validateEffectiveConfiguration } from "./schema-validation";
import { resolveMemberSchemas } from "./schema-validation-paths";
import { isSchemaArray } from "./schema-validation-support";

/** Checks defaults in their complete member context, even beneath absent optional parents. */
export function validateConfigurationDefaults(
  schema: ConfigurationPropertySchema,
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  checkGroup([schema], [], errors);
  return { valid: errors.length === 0, errors };
}

function checkGroup(
  schemas: readonly ConfigurationPropertySchema[],
  path: readonly (string | number)[],
  errors: SchemaValidationError[],
): void {
  checkMarkerSample(schemas, path, errors);
  for (const schema of schemas) checkDefault(schema, schemas, path, errors);
  checkProperties(schemas, path, errors);
  checkItems(schemas, path, errors);
  checkPatterns(schemas, path, errors);
  for (const schema of schemas) {
    const additional = schema.additionalProperties;
    if (typeof additional === "object")
      checkGroup([additional], [...path, "additionalProperties"], errors);
  }
}

function checkPatterns(
  schemas: readonly ConfigurationPropertySchema[],
  path: readonly (string | number)[],
  errors: SchemaValidationError[],
): void {
  const patterns = schemas.flatMap((schema) =>
    Object.entries(schema.patternProperties ?? {}),
  );
  for (const [pattern, child] of patterns)
    checkGroup([child], [...path, "patternProperties", pattern], errors);
  // Without solving regex intersections, require defaults to tolerate every potentially overlapping branch.
  if (patterns.length > 1)
    checkGroup(
      patterns.map(([, child]) => child),
      [...path, "patternProperties"],
      errors,
    );
}

function checkMarkerSample(
  schemas: readonly ConfigurationPropertySchema[],
  path: readonly (string | number)[],
  errors: SchemaValidationError[],
): void {
  // Probe a possible discriminator declaration supplied by another governing schema.
  const probe: ConfigurationPropertySchema = {
    type: "object",
    properties: { _weaver: { type: "string" } },
  };
  const sample = materializeConfigurationDefaultsForSchemas(
    [...schemas, probe],
    {},
    false,
  );
  rejectMaterializedMarker(sample, path, errors);
}

function rejectMaterializedMarker(
  value: unknown,
  path: readonly (string | number)[],
  errors: SchemaValidationError[],
): void {
  if (!containsRegistrationDefaultMarker(value)) return;
  errors.push(
    defaultError(
      {
        code: "invalid-value",
        path: "$",
        segments: [],
        message:
          "Materialized defaults must not contain mount or secret-ref markers",
      },
      path,
    ),
  );
}

function checkDefault(
  schema: ConfigurationPropertySchema,
  governing: readonly ConfigurationPropertySchema[],
  path: readonly (string | number)[],
  errors: SchemaValidationError[],
): void {
  if (!Object.hasOwn(schema, "default")) return;
  const value = materializeConfigurationDefaultsForSchemas(
    governing,
    schema.default,
    false,
  );
  rejectMaterializedMarker(value, path, errors);
  for (const constraint of governing) {
    const result = validateEffectiveConfiguration(constraint, value);
    for (const error of result.errors) errors.push(defaultError(error, path));
  }
}

function checkProperties(
  schemas: readonly ConfigurationPropertySchema[],
  path: readonly (string | number)[],
  errors: SchemaValidationError[],
): void {
  const keys = new Set(
    schemas.flatMap((schema) => Object.keys(schema.properties ?? {})),
  );
  for (const key of keys) {
    const members = schemas.map((schema) =>
      resolveMemberSchemas(schema, [key], []),
    );
    const children = members.flatMap((member) => member.schemas);
    if (children.some((child) => Object.hasOwn(child, "default"))) {
      for (const error of members.flatMap((member) => member.errors))
        errors.push(defaultError(error, [...path, key]));
    }
    checkGroup(children, [...path, key], errors);
  }
}

function checkItems(
  schemas: readonly ConfigurationPropertySchema[],
  path: readonly (string | number)[],
  errors: SchemaValidationError[],
): void {
  const items = schemas.flatMap((schema) =>
    schema.items ? [schema.items] : [],
  );
  const length = Math.max(
    0,
    ...items.map((item) => (isSchemaArray(item) ? item.length : 1)),
  );
  for (let index = 0; index < length; index++) {
    const children = items.flatMap((item) => {
      const child = isSchemaArray(item) ? item[index] : item;
      return child ? [child] : [];
    });
    checkGroup(children, [...path, "items", index], errors);
  }
}

function defaultError(
  error: SchemaValidationError,
  path: readonly (string | number)[],
): SchemaValidationError {
  return {
    ...error,
    message: `Invalid default at ${JSON.stringify(path)}: ${error.message}`,
  };
}
