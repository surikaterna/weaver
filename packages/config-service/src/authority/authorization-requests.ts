import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  type AuthorityGrant,
  type AuthorizationRequest,
  authorizationRequestSchema,
  type ConfigurationServiceIdentity,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import { identityKey } from "../layer-stack";
import { forbidden } from "./capability-registry";

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
  operation: "read" | "inspect" | "write",
  layer?: string,
): AuthorizationRequest {
  const parsed = authorizationRequestSchema.safeParse({
    identity,
    namespace,
    path,
    operation,
    sensitive: false,
    ...(layer === undefined ? {} : { layer }),
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
    grant.namespace === request.namespace &&
    covers(grant.namespace, request.path) &&
    grant.operations.includes(request.operation) &&
    layers.every((layer) => grant.layers.includes(layer)) &&
    request.viewId === undefined &&
    !request.sensitive
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
