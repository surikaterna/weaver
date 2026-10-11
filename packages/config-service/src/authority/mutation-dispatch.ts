import {
  type ConfigurationMutationReceipt,
  type ConfigurationMutationResult,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { RootState } from "../root-state";
import { auditWrite } from "./authority-audit";
import { type MutationTicket, mutationTarget } from "./authority-write";
import type { MutationPlan } from "./mutation-plan";
import { reconcileMutations } from "./mutation-reconcile";
import { mutationError, mutationRevisions } from "./mutation-result";
import { publish } from "./publication";
import { acceptEffect, finishEffect } from "./registry-effects";
import { fenceWrites } from "./write-outcome";

type Acceptance = "accepted" | "rejected" | "unknown" | "not-attempted";
interface Execution {
  readonly effects: Acceptance[];
  readonly touched: Map<MutationPlan["writer"], MutationPlan>;
  error: ReturnType<typeof mutationError>;
}

export async function dispatchMutations(
  state: RootState,
  ticket: MutationTicket,
  plans: readonly MutationPlan[],
): Promise<ConfigurationMutationResult> {
  const execution: Execution = {
    effects: plans.map(() => "not-attempted"),
    touched: new Map(),
    error: mutationError(createWeaverError("WRITE_ERROR", "Mutation rejected")),
  };
  await dispatchOrdered(state, ticket, plans, execution);
  const flushed = new Map<MutationPlan["writer"], "committed" | "unknown">();
  for (const [writer] of execution.touched) {
    const outcome = await finishEffect(writer);
    flushed.set(writer, outcome);
    if (outcome === "unknown")
      fenceWrites(
        state,
        [...execution.touched.values()].map((plan) => plan.target),
      );
  }
  const results = receipts(plans, execution, flushed);
  const result = finishPublication(
    state,
    ticket,
    plans,
    results,
    execution.error,
  );
  if (!result.success && result.outcome === "unknown")
    await reconcileMutations(state, [...execution.touched.values()]);
  await auditResults(state, ticket, plans, results);
  return result;
}

async function dispatchOrdered(
  state: RootState,
  ticket: MutationTicket,
  plans: readonly MutationPlan[],
  execution: Execution,
): Promise<void> {
  for (const [index, plan] of plans.entries()) {
    try {
      ticket.check();
      mutationTarget(state, ticket, plan.command);
    } catch (error) {
      execution.error = mutationError(error);
      execution.effects[index] = "rejected";
      break;
    }
    const effect = plan.effect;
    const outcome = await acceptEffect(plan.writer, () =>
      effect.operation === "set"
        ? plan.writer.write(effect.key, effect.value)
        : plan.writer.remove(effect.key),
    );
    execution.effects[index] = outcome;
    if (outcome !== "rejected")
      execution.touched.set(
        plan.writer,
        execution.touched.get(plan.writer) ?? plan,
      );
    if (outcome === "unknown")
      fenceWrites(
        state,
        [...execution.touched.values()].map((item) => item.target),
      );
    if (outcome !== "accepted") break;
  }
}

function receipts(
  plans: readonly MutationPlan[],
  execution: Execution,
  flushed: ReadonlyMap<MutationPlan["writer"], "committed" | "unknown">,
): readonly ConfigurationMutationReceipt[] {
  return Object.freeze(
    plans.map((plan, index): ConfigurationMutationReceipt => {
      const accepted = execution.effects[index];
      if (accepted === "accepted" && flushed.get(plan.writer) === "committed")
        return Object.freeze({ index, effect: "committed" });
      if (accepted === "accepted" || accepted === "unknown")
        return Object.freeze({
          index,
          effect: "unknown",
          error: mutationError(
            createWeaverError(
              "WRITE_OUTCOME_UNKNOWN",
              "Mutation outcome unknown",
            ),
          ),
        });
      if (accepted === "rejected")
        return Object.freeze({
          index,
          effect: "rejected",
          error: execution.error,
        });
      return Object.freeze({ index, effect: "not-attempted" });
    }),
  );
}

function finishPublication(
  state: RootState,
  ticket: MutationTicket,
  plans: readonly MutationPlan[],
  results: readonly ConfigurationMutationReceipt[],
  error: ReturnType<typeof mutationError>,
): ConfigurationMutationResult {
  if (results.some((item) => item.effect === "unknown"))
    return Object.freeze({
      success: false,
      outcome: "unknown",
      error: mutationError(
        createWeaverError("WRITE_OUTCOME_UNKNOWN", "Mutation outcome unknown"),
      ),
      results,
    });
  const count = results.filter((item) => item.effect === "committed").length;
  const plan = plans[count - 1];
  if (!plan)
    return Object.freeze({
      success: false,
      outcome: "rejected",
      error,
      results,
    });
  const revisions = mutationRevisions(
    ticket.commands.slice(0, count),
    plan.after.revision,
  );
  if (count === plans.length) {
    const committed = results.filter((item) => item.effect === "committed");
    const success = Object.freeze({
      success: true as const,
      results: Object.freeze(committed),
      revisions,
    });
    publish(state, plan.after);
    return success;
  }
  const partial = Object.freeze({
    success: false as const,
    outcome: "partial" as const,
    error,
    results,
    revisions,
  });
  publish(state, plan.after);
  return partial;
}

async function auditResults(
  state: RootState,
  ticket: MutationTicket,
  plans: readonly MutationPlan[],
  results: readonly ConfigurationMutationReceipt[],
): Promise<void> {
  for (const receipt of results) {
    const plan = plans[receipt.index];
    if (!plan || receipt.effect === "not-attempted") continue;
    await auditWrite(
      state,
      {
        principal: ticket.principal,
        request: plan.request,
        commandIndex: receipt.index,
      },
      receipt.effect === "rejected" ? "denied" : receipt.effect,
    );
  }
}
