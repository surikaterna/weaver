import type { AuthFunctions } from "@weaver-conf/config-auth";
import { deepGet, parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import { registeredMutationEvidence } from "@weaver-conf/config-registry";
import {
  authorizationDecisionSchema,
  type ConfigurationSessionActivation,
  type ConfigurationSessionInfo,
  configurationAuthorizationRequestSchema,
  createWeaverError,
  type SessionAuthorizationRequest,
  sessionAuthorizationRequestSchema,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import { currentIdentity } from "../identity-state";
import { identityKey } from "../layer-stack";
import { assertLive, type RootState } from "../root-state";
import { deriveView } from "../view-snapshots";
import { invokeWriteHook } from "./authority-audit";
import { selectGrant } from "./authorization-requests";
import {
  type createCapabilityRegistry,
  forbidden,
} from "./capability-registry";
import { compileMutationPath } from "./mutation-capture";
import type { SessionReference, SessionRemovalCause } from "./session-bindings";

export interface SessionAccess {
  readonly state: RootState;
  readonly token: unknown;
  readonly principal: TrustedPrincipalSnapshot;
  readonly registry: ReturnType<typeof createCapabilityRegistry>;
  readonly auth: AuthFunctions;
}

export function checkSessionAccess(
  access: SessionAccess,
  request: SessionAuthorizationRequest,
  ref?: SessionReference,
): void {
  const { state, principal, registry, token } = access;
  assertLive(state);
  if (
    request.identity.environment !== state.factory.options.identity.environment
  )
    forbidden();
  if (registry.current(token).snapshot !== principal) forbidden();
  const permission = permissionFor(request.operation);
  if (!principal.sessionPermissions?.includes(permission)) forbidden();
  if (
    request.emergency &&
    permission === "activate" &&
    !principal.sessionPermissions.includes("emergency")
  )
    forbidden();
  if (
    ref &&
    ref.owner !== token &&
    !principal.sessionPermissions.includes("manage")
  )
    forbidden();
  checkSessionGrants(access, request, false);
  if (
    (permission === "activate" || permission === "extend") &&
    !access.auth.canWrite(
      { userId: principal.principalId, roles: principal.roles },
      request.layer,
      request.namespace,
      undefined,
    )
  )
    forbidden();
  if (permission !== "deactivate" && checkNamespacePolicy(access, request))
    checkSessionGrants(access, request, true);
}

function checkSessionGrants(
  access: SessionAccess,
  request: SessionAuthorizationRequest,
  sensitive: boolean,
): void {
  const operations =
    request.operation === "session-read"
      ? (["read", "inspect"] as const)
      : (["write"] as const);
  for (const operation of operations) {
    selectGrant(
      access.principal,
      configurationAuthorizationRequestSchema.parse({
        identity: request.identity,
        namespace: request.namespace,
        path: request.namespace,
        layer: request.layer,
        viewId: request.viewId,
        operation,
        sensitive,
        ...(operation === "write" ? { mutation: "set" as const } : {}),
      }),
      [request.layer],
    );
  }
}

function checkNamespacePolicy(
  access: SessionAccess,
  request: SessionAuthorizationRequest,
): boolean {
  const paths = new Set([
    request.namespace,
    compileMutationPath({
      ...request,
      operation: "remove",
      path: request.namespace,
    }),
  ]);
  let sensitive = false;
  const values =
    access.state.ready.get(identityKey(request.identity))?.raw.entries ?? {};
  const context = {
    userId: access.principal.principalId,
    roles: access.principal.roles,
  };
  for (const path of paths) {
    const anchor = access.state.factory.registry.resolveAnchor(
      path,
      request.identity.environment,
    );
    if (!anchor)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Session namespace is not declared",
      );
    const root = parseCanonicalConfigPath(anchor.path);
    const evidence = registeredMutationEvidence(
      anchor.schema,
      parseCanonicalConfigPath(path).segments.slice(root.segments.length),
      deepGet(values, root.storageKey),
    );
    if (!evidence.declared)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Session namespace is not declared",
      );
    if (evidence.forbidden || evidence.reference) forbidden();
    for (const schema of [...evidence.ancestors, ...evidence.schemas]) {
      if (!access.auth.canRead(context, path, schema)) forbidden();
    }
    sensitive ||= evidence.sensitive;
  }
  return sensitive;
}

function permissionFor(operation: SessionAuthorizationRequest["operation"]) {
  switch (operation) {
    case "session-read":
      return "read";
    case "session-activate":
      return "activate";
    case "session-extend":
      return "extend";
    case "session-deactivate":
      return "deactivate";
  }
}

export async function authorizeSession(
  access: SessionAccess,
  request: SessionAuthorizationRequest,
  ref?: SessionReference,
): Promise<void> {
  checkSessionAccess(access, request, ref);
  let decision: unknown;
  try {
    decision = await invokeWriteHook(access.state, () =>
      access.state.factory.host.hostAuthority.authorizeWrite(
        access.principal,
        request,
      ),
    );
  } catch {
    forbidden();
  }
  checkSessionAccess(access, request, ref);
  if (authorizationDecisionSchema.safeParse(decision).data !== "allowed")
    forbidden();
}

export function sessionRequest(
  selection: ConfigurationSessionActivation | ConfigurationSessionInfo,
  layer: string,
  operation: SessionAuthorizationRequest["operation"],
  cause?: SessionRemovalCause,
): SessionAuthorizationRequest {
  return sessionAuthorizationRequestSchema.parse({
    identity: selection.identity,
    namespace: selection.namespace,
    ...(selection.viewId === undefined ? {} : { viewId: selection.viewId }),
    layer,
    operation,
    reason: selection.reason,
    emergency: selection.emergency,
    ...(cause === undefined ? {} : { cause }),
    ...("id" in selection ? { sessionId: selection.id } : {}),
    ...("durationMs" in selection && selection.durationMs !== undefined
      ? { durationMs: selection.durationMs }
      : {}),
  });
}

export function declareSessionTarget(
  state: RootState,
  request: ConfigurationSessionActivation,
): void {
  const path = parseCanonicalConfigPath(request.namespace);
  if (path.segments.includes("instances")) forbidden();
  const base = currentIdentity(state, request.identity);
  const anchor = state.factory.registry.resolveAnchor(
    request.namespace,
    request.identity.environment,
  );
  if (!anchor)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "Session namespace is not declared",
    );
  const root = parseCanonicalConfigPath(anchor.path);
  const evidence = registeredMutationEvidence(
    anchor.schema,
    path.segments.slice(root.segments.length),
    deepGet(base.raw.entries, root.storageKey),
  );
  if (!evidence.declared)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "Session namespace is not declared",
    );
  if (evidence.forbidden || evidence.reference) forbidden();
  if (request.viewId !== undefined)
    deriveView(base, request, state.factory.registry, true);
}
