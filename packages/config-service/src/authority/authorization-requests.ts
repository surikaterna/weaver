import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  type AuthorityGrant,
  type ConfigurationAuthorizationRequest as AuthorizationRequest,
  configurationAuthorizationRequestSchema as authorizationRequestSchema,
  type CanonicalConfigurationPath,
  type ConfigurationServiceIdentity,
  canonicalConfigurationPathSchema,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import { identityKey } from "../layer-stack";
import { forbidden } from "./capability-registry";

/** Opaque JSON member names are governed by their nearest addressable ancestor,
 * never reinterpreted as slash paths or exposed as another addressing dialect. */
export function evidencePath(
  segments: readonly string[],
): CanonicalConfigurationPath {
  for (let length = segments.length; length > 0; length--) {
    const prefix = segments.slice(0, length);
    const parsed = canonicalConfigurationPathSchema.safeParse(
      `/${prefix.join("/")}`,
    );
    if (
      parsed.success &&
      parseCanonicalConfigPath(parsed.data).segments.length === prefix.length
    )
      return parsed.data;
  }
  return forbidden();
}

export function covers(namespace: string, path: string): boolean {
  const prefix = parseCanonicalConfigPath(namespace).segments;
  const segments = parseCanonicalConfigPath(path).segments;
  return (
    prefix.length <= segments.length &&
    prefix.every((part, index) => part === segments[index])
  );
}
export function identityMatches(
  a: ConfigurationServiceIdentity,
  b: ConfigurationServiceIdentity,
): boolean {
  return identityKey(a) === identityKey(b);
}
export function requestFor(
  identity: ConfigurationServiceIdentity,
  namespace: string,
  path: string,
  operation: "read" | "inspect",
  layer?: string,
  viewId?: string,
): AuthorizationRequest {
  const parsed = authorizationRequestSchema.safeParse({
    identity,
    namespace,
    path,
    operation,
    sensitive: false,
    ...(layer === undefined ? {} : { layer }),
    ...(viewId === undefined ? {} : { viewId }),
  });
  if (!parsed.success) return forbidden();
  return parsed.data;
}
export function grantAllows(
  grant: AuthorityGrant,
  request: AuthorizationRequest,
  layers: readonly string[],
): boolean {
  return (
    identityMatches(grant.identity, request.identity) &&
    covers(grant.namespace, request.namespace) &&
    covers(request.namespace, request.path) &&
    covers(grant.namespace, request.path) &&
    grant.operations.includes(request.operation) &&
    layers.every((layer) => grant.layers.includes(layer)) &&
    (request.viewId === undefined
      ? grant.views.length === 0
      : grant.views.includes(request.viewId)) &&
    (!request.sensitive || grant.sensitive)
  );
}
export function selectGrant(
  snapshot: TrustedPrincipalSnapshot,
  request: AuthorizationRequest,
  layers: readonly string[],
): void {
  if (
    snapshot.session ||
    !snapshot.grants.some((grant) => grantAllows(grant, request, layers))
  )
    forbidden();
}
