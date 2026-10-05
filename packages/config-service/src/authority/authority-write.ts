import type { AuthFunctions } from "@weaver-conf/config-auth";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  type AuthorizationRequest,
  authorizationDecisionSchema,
  type ConfigurationServiceIdentity,
  type ConfigurationServiceWriteOptions,
  configurationServiceWriteOptionsSchema,
  createWeaverError,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import type { LoadedContribution } from "../hydration";
import { currentIdentity } from "../identity-state";
import { assertLive, type RootState } from "../root-state";
import { invokeWriteHook } from "./authority-audit";
import {
  covers,
  identityMatches,
  requestFor,
  selectGrant,
} from "./authorization-requests";
import type { createCapabilityRegistry } from "./capability-registry";

export interface WriteTicket {
  readonly principal: TrustedPrincipalSnapshot;
  readonly request: AuthorizationRequest;
  readonly options: ConfigurationServiceWriteOptions;
  readonly key: string;
  readonly operation: "set" | "remove";
  readonly value: unknown;
  readonly auth: AuthFunctions;
  readonly check: () => LoadedContribution;
}
type Registry = ReturnType<typeof createCapabilityRegistry>;
export function checkWriteInvocation(
  state: RootState,
  ticket: WriteTicket,
): void {
  if (ticket.principal.session) fail("POLICY_VIOLATION");
  selectGrant(ticket.principal, ticket.request, [ticket.options.layer]);
  if (
    ticket.request.identity.environment !==
    state.factory.options.identity.environment
  )
    fail("FORBIDDEN");
  currentIdentity(state, ticket.request.identity);
}
export function captureWrite(
  state: RootState,
  registry: Registry,
  auth: AuthFunctions,
  token: unknown,
  identity: ConfigurationServiceIdentity,
  namespace: string | undefined,
  path: unknown,
  operation: "set" | "remove",
  value: unknown,
  input: unknown,
): WriteTicket {
  const captured = captureInput(path, operation, value, input);
  const principal = registry.current(token).snapshot;
  const selected =
    namespace ??
    selectNamespace(principal, identity, captured.path, captured.options.layer);
  const request = requestFor(
    identity,
    selected,
    captured.path,
    "write",
    captured.options.layer,
  );
  const check = createCheck(
    state,
    registry,
    token,
    principal,
    request,
    captured.options,
  );
  return Object.freeze({
    principal,
    request,
    options: captured.options,
    key: captured.key,
    operation,
    value,
    auth,
    check,
  });
}
function captureInput(
  path: unknown,
  operation: "set" | "remove",
  value: unknown,
  input: unknown,
) {
  const options = configurationServiceWriteOptionsSchema.safeParse(input);
  if (!options.success || typeof path !== "string") fail("VALIDATION_ERROR");
  const parsedPath = parseCanonicalConfigPath(path);
  if (
    operation === "set" &&
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  )
    fail("UNSUPPORTED_OPERATION");
  return {
    options: options.data,
    path: parsedPath.path,
    key: parsedPath.storageKey,
  };
}
function selectNamespace(
  principal: TrustedPrincipalSnapshot,
  identity: ConfigurationServiceIdentity,
  path: string,
  layer: string,
): string {
  const selected = principal.grants.find(
    (grant) =>
      identityMatches(grant.identity, identity) &&
      grant.operations.includes("write") &&
      grant.layers.includes(layer) &&
      covers(grant.namespace, path),
  )?.namespace;
  if (!selected) fail("FORBIDDEN");
  return selected;
}
function createCheck(
  state: RootState,
  registry: Registry,
  token: unknown,
  principal: TrustedPrincipalSnapshot,
  request: AuthorizationRequest,
  options: ConfigurationServiceWriteOptions,
) {
  return () => {
    assertLive(state);
    if (state.writeFence) fail("WRITE_UNAVAILABLE");
    if (registry.current(token).snapshot !== principal) fail("FORBIDDEN");
    if (principal.session) fail("POLICY_VIOLATION");
    selectGrant(principal, request, [options.layer]);
    if (
      request.identity.environment !==
      state.factory.options.identity.environment
    )
      fail("FORBIDDEN");
    const current = currentIdentity(state, request.identity);
    if (
      options.ifRevision !== undefined &&
      options.ifRevision !== current.revision
    )
      fail("REVISION_CONFLICT");
    if (current.degradedProviders.length) fail("SERVER_DEGRADED");
    return targetFor(
      state,
      current.contributions,
      request.identity,
      options.layer,
    );
  };
}
function targetFor(
  state: RootState,
  contributions: readonly LoadedContribution[],
  identity: ConfigurationServiceIdentity,
  layer: string,
): LoadedContribution {
  const slot = state.factory.options.layers.find(
    (item) => item.layer === layer,
  );
  if (!slot) fail("NOT_FOUND");
  if (
    slot.kind === "fixed"
      ? identity.scopePath.length !== 0
      : identity.scopePath.length === 0
  )
    fail("FORBIDDEN");
  const target = contributions
    .filter((item) => item.selection.captured.binding.layer === layer)
    .at(-1);
  if (!target || !state.factory.writers.has(target.selection.captured))
    fail("WRITE_UNAVAILABLE");
  return target;
}
export async function authorizeWrite(
  state: RootState,
  ticket: WriteTicket,
): Promise<void> {
  const host = state.factory.host.hostAuthority;
  if (!host) fail("WRITE_UNAVAILABLE");
  try {
    const decision = await invokeWriteHook(state, () =>
      host.authorizeWrite(ticket.principal, ticket.request),
    );
    if (authorizationDecisionSchema.safeParse(decision).data !== "allowed")
      fail("FORBIDDEN");
  } catch {
    fail("FORBIDDEN");
  }
}
function fail(code: Parameters<typeof createWeaverError>[0]): never {
  throw createWeaverError(code, "Configuration write denied");
}
