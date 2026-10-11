import type { ConfigurationMutationCommand } from "@weaver-conf/config-types";
import { identityKey } from "../layer-stack";
import type { RootState } from "../root-state";
import type { MutationTicket } from "./authority-write";
import { covers } from "./authorization-requests";
import { forbidden } from "./capability-registry";
import { requireSessionInfo } from "./session-lifecycle";

export function checkedSessionMutation(
  state: RootState,
  ticket: MutationTicket,
  command: ConfigurationMutationCommand,
) {
  const ref =
    command.sessionId === undefined
      ? undefined
      : state.sessions.get(command.sessionId);
  if (
    !ref ||
    ref.selection.captured.binding.layer !== command.layer ||
    identityKey(ref.target.identity) !== identityKey(command.identity) ||
    ref.target.namespace !== command.namespace ||
    ref.target.viewId !== command.viewId ||
    !covers(ref.target.namespace, command.path)
  )
    return forbidden();
  if (
    ref.owner !== ticket.token &&
    !ticket.principal.sessionPermissions?.includes("manage")
  )
    return forbidden();
  if (
    ref.emergency &&
    !ticket.principal.sessionPermissions?.includes("emergency")
  )
    return forbidden();
  requireSessionInfo(ref);
  return ref;
}
