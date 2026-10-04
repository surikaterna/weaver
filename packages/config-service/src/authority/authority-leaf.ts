import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import type { CanonicalSchemaRegistryReader } from "@weaver-conf/config-registry";
import {
  type AuthorizationRequest,
  type ConfigurationPropertySchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { covers } from "./authorization-requests";

function concrete(schema: ConfigurationPropertySchema): void {
  if (
    schema.oneOf ||
    schema.anyOf ||
    schema.allOf ||
    schema.not ||
    schema.patternProperties ||
    typeof schema.additionalProperties === "object" ||
    schema.items
  )
    throw createWeaverError(
      "UNSUPPORTED_OPERATION",
      "Only concrete property writes are supported",
    );
  if (
    schema["x-weaver"]?.sensitive ||
    (schema["x-weaver"]?.visibility ?? "public") !== "public"
  )
    throw createWeaverError("FORBIDDEN", "Configuration authority denied");
}
function ancestors(
  schema: ConfigurationPropertySchema,
  segments: readonly string[],
): readonly ConfigurationPropertySchema[] {
  const result: ConfigurationPropertySchema[] = [];
  let current = schema;
  for (const part of segments) {
    concrete(current);
    if (part === "instances" || current.type !== "object")
      throw createWeaverError(
        "UNSUPPORTED_OPERATION",
        "Only concrete property writes are supported",
      );
    result.push(current);
    const next =
      current.properties && Object.hasOwn(current.properties, part)
        ? current.properties[part]
        : undefined;
    if (!next)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Schema is not registered",
      );
    current = next;
  }
  concrete(current);
  if (
    typeof current.type !== "string" ||
    !["string", "number", "integer", "boolean", "null"].includes(current.type)
  )
    throw createWeaverError(
      "UNSUPPORTED_OPERATION",
      "Only primitive leaf writes are supported",
    );
  result.push(current);
  return result;
}
export function writeAncestors(
  registry: CanonicalSchemaRegistryReader,
  request: AuthorizationRequest,
): readonly ConfigurationPropertySchema[] {
  const result: ConfigurationPropertySchema[] = [];
  const target = parseCanonicalConfigPath(request.path).segments;
  for (const identity of registry.listRegisteredSchemaIdentities().anchors) {
    if (
      identity.environment !== request.identity.environment ||
      !covers(identity.path, request.path)
    )
      continue;
    const anchor = registry.getRegisteredSchema(
      identity.path,
      identity.environment,
    );
    if (!anchor)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Schema is not registered",
      );
    result.push(
      ...ancestors(
        anchor.schema,
        target.slice(parseCanonicalConfigPath(identity.path).segments.length),
      ),
    );
  }
  if (!result.length)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "Schema is not registered",
    );
  return result;
}
