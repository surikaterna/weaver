import {
  consoleLogger,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import {
  type ConfigurationAuthorityController,
  type ConfigurationMutationAuthority,
  type ConfigurationNamespace,
  type ConfigurationReader,
  type ConfigurationServiceIdentity,
  createWeaverError,
  type TrustedPrincipalSnapshot,
  trustedPrincipalSnapshotSchema,
} from "@weaver-conf/config-types";
import type { AuthContext } from "../auth/auth-middleware";
import type { ServerAuthorityOptions } from "../server-authority-options";
import type { SelectedAuthorityRequest } from "./authority-rest-request";

export function authorityDiagnostic(): void {
  try {
    consoleLogger.error("[authority] cleanup failed");
  } catch {
    /* Diagnostics must not replace a known operation outcome. */
  }
}

function signedExpiry(
  context: AuthContext,
  now: () => number,
): number | undefined {
  const exp = context.identity.claims.exp;
  if (exp === undefined) return undefined;
  if (
    typeof exp !== "number" ||
    !Number.isFinite(exp * 1000) ||
    exp * 1000 <= now()
  )
    throw createWeaverError("UNAUTHORIZED", "Authentication required");
  return exp * 1000;
}

function mappedPrincipal(
  options: ServerAuthorityOptions,
  context: AuthContext,
  identity: ConfigurationServiceIdentity,
): TrustedPrincipalSnapshot {
  const expiry = signedExpiry(context, options.now ?? Date.now);
  try {
    const mapped: unknown = options.mapPrincipal(context, identity);
    if (mapped instanceof Promise) {
      void Promise.prototype.then.call(mapped, undefined, () => {});
      throw createWeaverError("FORBIDDEN", "Principal mapping denied");
    }
    const principal = trustedPrincipalSnapshotSchema.parse(mapped);
    if (expiry === undefined) return principal;
    return trustedPrincipalSnapshotSchema.parse({
      ...principal,
      expiresAt: Math.min(principal.expiresAt ?? expiry, expiry),
    });
  } catch {
    throw createWeaverError("FORBIDDEN", "Principal mapping denied");
  }
}

function sameIdentity(
  left: ConfigurationServiceIdentity,
  right: ConfigurationServiceIdentity,
) {
  return (
    left.environment === right.environment &&
    left.scopePath.length === right.scopePath.length &&
    left.scopePath.every(
      (scope, index) =>
        scope.scopeId === right.scopePath[index]?.scopeId &&
        scope.value === right.scopePath[index]?.value,
    )
  );
}

function selectedNamespace(
  principal: TrustedPrincipalSnapshot,
  selected: SelectedAuthorityRequest,
) {
  const matching = principal.grants
    .filter((grant) => {
      const segments = parseCanonicalConfigPath(grant.namespace).segments;
      return (
        sameIdentity(grant.identity, selected.identity) &&
        segments.every(
          (segment, index) => selected.parsed.segments[index] === segment,
        )
      );
    })
    .sort(
      (left, right) =>
        parseCanonicalConfigPath(right.namespace).segments.length -
        parseCanonicalConfigPath(left.namespace).segments.length,
    );
  const namespace = matching[0]?.namespace;
  if (namespace === undefined)
    throw createWeaverError("FORBIDDEN", "Namespace not authorized");
  return namespace;
}

export interface AuthorityRequestContext {
  readonly query: ConfigurationReader;
  readonly mutations: ConfigurationMutationAuthority;
  readonly identity: ConfigurationServiceIdentity;
  readonly namespace: ConfigurationNamespace;
}

export async function withAuthorityRequest<T>(
  options: ServerAuthorityOptions,
  controller: ConfigurationAuthorityController,
  context: AuthContext,
  selected: SelectedAuthorityRequest,
  assertOpen: () => void,
  operation: (context: AuthorityRequestContext) => T | Promise<T>,
): Promise<T> {
  assertOpen();
  const principal = mappedPrincipal(options, context, selected.identity);
  const namespace = selectedNamespace(principal, selected);
  assertOpen();
  const token = controller.mint(principal);
  try {
    const port = controller.forIdentity(token, {
      identity: selected.identity,
      namespace,
    });
    await port.prepare();
    assertOpen();
    return await operation({
      query: port,
      mutations: controller.forMutations(token),
      identity: selected.identity,
      namespace,
    });
  } finally {
    try {
      controller.revoke(token);
    } catch {
      authorityDiagnostic();
    }
  }
}
