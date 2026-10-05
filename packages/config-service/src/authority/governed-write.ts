import type { AuthFunctions } from "@weaver-conf/config-auth";
import type {
  ConfigurationServiceIdentity,
  ConfigurationServiceWriteResult,
} from "@weaver-conf/config-types";
import type { RootState } from "../root-state";
import { auditWrite } from "./authority-audit";
import {
  authorizeWrite,
  captureWrite,
  checkWriteInvocation,
  type WriteTicket,
} from "./authority-write";
import type { createCapabilityRegistry } from "./capability-registry";
import { publish, stagePublication } from "./publication";
import {
  dispatchWrite,
  reconcileUnknown,
  rejected,
  rejection,
} from "./write-outcome";
import { admitWritePolicy } from "./write-policy";

type WriteExecutor = (
  token: unknown,
  identity: ConfigurationServiceIdentity,
  namespace: string | undefined,
  path: unknown,
  operation: "set" | "remove",
  value: unknown,
  options: unknown,
) => Promise<ConfigurationServiceWriteResult>;
export function createWriteExecutor(
  state: RootState,
  registry: ReturnType<typeof createCapabilityRegistry>,
  auth: AuthFunctions | undefined,
): WriteExecutor {
  return (...args) => enqueueWrite(state, registry, auth, args);
}
function enqueueWrite(
  state: RootState,
  registry: ReturnType<typeof createCapabilityRegistry>,
  auth: AuthFunctions | undefined,
  args: Parameters<WriteExecutor>,
): Promise<ConfigurationServiceWriteResult> {
  if (state.disposed) return Promise.resolve(rejected("DISPOSED"));
  if (!auth || !args[0] || !state.factory.writers.size || state.writeFence)
    return Promise.resolve(rejected("WRITE_UNAVAILABLE"));
  if (state.writeHookActive) return Promise.resolve(rejected("FORBIDDEN"));
  let ticket: WriteTicket | undefined;
  try {
    ticket = captureWrite(state, registry, auth, ...args);
    checkWriteInvocation(state, ticket);
    const captured = ticket;
    return state.queue.enqueue(() => execute(state, captured));
  } catch (error) {
    return ticket
      ? auditWrite(state, ticket, "denied").then(() => rejection(error))
      : Promise.resolve(rejection(error));
  }
}
async function execute(
  state: RootState,
  ticket: WriteTicket,
): Promise<ConfigurationServiceWriteResult> {
  let target: ReturnType<WriteTicket["check"]>;
  let plan: ReturnType<typeof stagePublication>;
  try {
    target = ticket.check();
    await authorizeWrite(state, ticket);
    ticket.check();
    admitWritePolicy(
      state,
      ticket.principal,
      ticket.request,
      ticket.auth,
      ticket.options.layer,
    );
    plan = stagePublication(state, ticket, target);
    await auditWrite(state, ticket, "before-dispatch");
    ticket.check();
  } catch (error) {
    await auditWrite(state, ticket, "denied");
    return rejection(error);
  }
  const writer = state.factory.writers.get(target.selection.captured);
  if (!writer) return rejected("WRITE_UNAVAILABLE");
  const outcome = await dispatchWrite(state, ticket, target, writer);
  if (outcome === "committed") {
    publish(state, plan);
    await auditWrite(state, ticket, "committed");
    return {
      success: true,
      layer: ticket.options.layer,
      revision: plan.revision,
    };
  }
  if (outcome === "unknown") {
    const result = await reconcileUnknown(state, ticket, target);
    await auditWrite(state, ticket, "unknown");
    return result;
  }
  await auditWrite(state, ticket, "denied");
  return rejected("WRITE_ERROR");
}
