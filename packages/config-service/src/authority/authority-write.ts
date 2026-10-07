import type { AuthFunctions } from "@weaver-conf/config-auth";
import {
  authorizationDecisionSchema,
  type ConfigurationAuthorizationRequest,
  type ConfigurationMutationCommand,
  createWeaverError,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import type { LoadedContribution } from "../hydration";
import type { IdentitySnapshot } from "../identity-snapshots";
import { currentIdentity } from "../identity-state";
import type { RootState } from "../root-state";
import { invokeWriteHook } from "./authority-audit";
import { selectGrant } from "./authorization-requests";
import { validateMutationSelection } from "./mutation-capture";
import { checkedSessionMutation } from "./session-mutations";

export interface MutationTicket {
  readonly token: unknown;
  readonly commands: readonly ConfigurationMutationCommand[];
  readonly principal: TrustedPrincipalSnapshot;
  readonly auth: AuthFunctions;
  readonly check: () => void;
}

export function mutationTarget(
  state: RootState,
  ticket: MutationTicket,
  command: ConfigurationMutationCommand,
  conditional = false,
): LoadedContribution {
  ticket.check();
  validateMutationSelection(command);
  selectGrant(ticket.principal, mutationRequest(command), [command.layer]);
  if (
    command.identity.environment !== state.factory.options.identity.environment
  )
    throw createWeaverError("FORBIDDEN", "Mutation identity denied");
  const snapshot = currentIdentity(state, command.identity);
  if (
    conditional &&
    command.ifRevision !== undefined &&
    command.ifRevision !== snapshot.revision
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Configuration revision changed",
    );
  if (snapshot.degradedProviders.length)
    throw createWeaverError("SERVER_DEGRADED", "Configuration is degraded");
  return selectMutationBinding(state, ticket, command, snapshot);
}

function selectMutationBinding(
  state: RootState,
  ticket: MutationTicket,
  command: ConfigurationMutationCommand,
  snapshot: IdentitySnapshot,
): LoadedContribution {
  const slot = state.factory.options.layers.find(
    (item) => item.layer === command.layer,
  );
  if (!slot) throw createWeaverError("NOT_FOUND", "Mutation layer unavailable");
  if (slot.kind === "session") {
    const ref = checkedSessionMutation(state, ticket, command);
    const target = snapshot.contributions.find(
      (item) => item.selection.captured === ref.selection.captured,
    );
    if (!target?.layer)
      throw createWeaverError(
        "WRITE_UNAVAILABLE",
        "Session contribution unavailable",
      );
    return target;
  }
  if (command.sessionId !== undefined)
    throw createWeaverError(
      "FORBIDDEN",
      "Session selector requires session layer",
    );
  if ((slot.kind === "fixed") !== (command.identity.scopePath.length === 0))
    throw createWeaverError("FORBIDDEN", "Mutation binding denied");
  const target = snapshot.contributions
    .filter((item) => item.selection.captured.binding.layer === command.layer)
    .at(-1);
  if (!target?.layer || !state.factory.writers.has(target.selection.captured))
    throw createWeaverError("WRITE_UNAVAILABLE", "Mutation writer unavailable");
  return target;
}

export function mutationRequest(
  command: ConfigurationMutationCommand,
  path = command.path,
  sensitive = false,
): ConfigurationAuthorizationRequest {
  return Object.freeze({
    identity: command.identity,
    namespace: command.namespace,
    path,
    layer: command.layer,
    operation: "write",
    mutation: command.operation,
    ...(command.sessionId === undefined
      ? {}
      : { sessionId: command.sessionId }),
    sensitive,
    ...(command.viewId === undefined ? {} : { viewId: command.viewId }),
  });
}

export async function authorizeMutation(
  state: RootState,
  ticket: MutationTicket,
  request: ConfigurationAuthorizationRequest,
): Promise<void> {
  selectGrant(
    ticket.principal,
    request,
    request.layer === undefined ? [] : [request.layer],
  );
  let decision: unknown;
  try {
    decision = await invokeWriteHook(state, () =>
      state.factory.host.hostAuthority?.authorizeWrite(
        ticket.principal,
        request,
      ),
    );
  } catch {
    ticket.check();
    throw createWeaverError("FORBIDDEN", "Mutation denied");
  }
  ticket.check();
  if (authorizationDecisionSchema.safeParse(decision).data !== "allowed")
    throw createWeaverError("FORBIDDEN", "Mutation denied");
}
