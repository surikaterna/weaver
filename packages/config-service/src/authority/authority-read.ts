import type { AuthFunctions } from "@weaver-conf/config-auth";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import type { CanonicalSchemaRegistryReader } from "@weaver-conf/config-registry";
import {
  type AuthorizationRequest,
  type ConfigurationPropertySchema,
  createWeaverError,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import { covers } from "./authorization-requests";
import { forbidden } from "./capability-registry";

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
    forbidden();
  if (
    schema["x-weaver"]?.sensitive ||
    (schema["x-weaver"]?.visibility ?? "public") !== "public"
  )
    forbidden();
}
function atLeaf(
  schema: ConfigurationPropertySchema,
  segments: readonly string[],
  snapshot: TrustedPrincipalSnapshot,
  request: AuthorizationRequest,
  auth: AuthFunctions,
): void {
  let current = schema;
  const access = { userId: snapshot.principalId, roles: snapshot.roles };
  for (const part of segments) {
    concrete(current);
    if (!auth.canRead(access, request.path, current)) forbidden();
    if (part === "instances") forbidden();
    if (!current.properties || !Object.hasOwn(current.properties, part))
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Schema is not registered",
      );
    const next = current.properties[part];
    if (!next) forbidden();
    current = next;
  }
  concrete(current);
  if (
    typeof current.type !== "string" ||
    current.type === "object" ||
    current.type === "array" ||
    !auth.canRead(access, request.path, current)
  )
    forbidden();
}
/** Admission only: returned data always comes from the canonical public projection. */
export function admitLeaf(
  registry: CanonicalSchemaRegistryReader,
  snapshot: TrustedPrincipalSnapshot,
  request: AuthorizationRequest,
  auth: AuthFunctions,
): void {
  const target = parseCanonicalConfigPath(request.path).segments;
  let declared = false;
  for (const identity of registry.listRegisteredSchemaIdentities().anchors) {
    if (
      identity.environment !== request.identity.environment ||
      !covers(identity.path, request.path)
    )
      continue;
    const anchor = registry.resolveAnchor(identity.path, identity.environment);
    if (!anchor || anchor.path !== identity.path) forbidden();
    const relative = target.slice(
      parseCanonicalConfigPath(identity.path).segments.length,
    );
    atLeaf(anchor.schema, relative, snapshot, request, auth);
    declared = true;
  }
  if (!declared)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "Schema is not registered",
    );
}
