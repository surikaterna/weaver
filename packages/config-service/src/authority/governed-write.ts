import type { AuthFunctions } from "@weaver-conf/config-auth";
import type {
  ConfigurationMutationAuthority,
  ConfigurationMutationResult,
} from "@weaver-conf/config-types";
import type { RootState } from "../root-state";
import { auditWrite } from "./authority-audit";
import {
  type MutationTicket,
  mutationRequest,
  mutationTarget,
} from "./authority-write";
import type { createCapabilityRegistry } from "./capability-registry";
import { captureMutations } from "./mutation-capture";
import { dispatchMutations } from "./mutation-dispatch";
import { type MutationPlan, stageMutation } from "./mutation-plan";
import { mutationRejection } from "./mutation-result";
import { initialPublication } from "./publication";
import { admitMutationPolicy } from "./write-policy";

export function createMutationAuthority(
  state: RootState,
  registry: ReturnType<typeof createCapabilityRegistry>,
  auth: AuthFunctions | undefined,
  token: unknown,
): ConfigurationMutationAuthority {
  registry.current(token);
  return Object.freeze<ConfigurationMutationAuthority>({
    apply: (input) => {
      let ticket: MutationTicket | undefined;
      let index = 0;
      try {
        ticket = captureMutations(state, registry, auth, token, input);
        for (const command of ticket.commands) {
          mutationTarget(state, ticket, command);
          index++;
        }
        const captured = ticket;
        return state.queue.enqueue(() => execute(state, captured));
      } catch (error) {
        return rejectedInvocation(state, ticket, index, error);
      }
    },
  });
}

async function rejectedInvocation(
  state: RootState,
  ticket: MutationTicket | undefined,
  index: number,
  error: unknown,
): Promise<ConfigurationMutationResult> {
  const result = mutationRejection(error, ticket?.commands, index);
  const command = ticket?.commands[index];
  if (ticket && command)
    await auditWrite(
      state,
      {
        principal: ticket.principal,
        request: mutationRequest(command),
        commandIndex: index,
      },
      "denied",
    );
  return result;
}

async function execute(
  state: RootState,
  ticket: MutationTicket,
): Promise<ConfigurationMutationResult> {
  let index = 0;
  const plans: MutationPlan[] = [];
  let draft = initialPublication(state);
  try {
    for (const command of ticket.commands) {
      const target = mutationTarget(state, ticket, command, true);
      const staged = stageMutation(state, draft, command, target);
      const request = await admitMutationPolicy(state, ticket, staged);
      const plan = Object.freeze({ ...staged, request });
      ticket.check();
      await auditWrite(
        state,
        { principal: ticket.principal, request, commandIndex: index },
        "before-dispatch",
      );
      ticket.check();
      mutationTarget(state, ticket, command);
      plans.push(plan);
      draft = plan.after;
      index++;
    }
    for (const [position, plan] of plans.entries()) {
      index = position;
      mutationTarget(state, ticket, plan.command);
    }
  } catch (error) {
    const command = ticket.commands[index];
    if (command)
      await auditWrite(
        state,
        {
          principal: ticket.principal,
          request: mutationRequest(command),
          commandIndex: index,
        },
        "denied",
      );
    return mutationRejection(error, ticket.commands, index);
  }
  return dispatchMutations(state, ticket, plans);
}
