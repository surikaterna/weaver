import {
  type ConfigurationServiceWriteResult,
  captureServiceData,
  type WeaverErrorCode,
  WeaverErrorInstance,
  writeResultSchema,
} from "@weaver-conf/config-types";
import { type LoadedContribution, loadContributions } from "../hydration";
import { errorData } from "../resource-ownership";
import type { RootState } from "../root-state";
import { validateAuthLayers } from "./authority-contract-capture";
import type { WriteTicket } from "./authority-write";
import type { CapturedWriter } from "./provider-write";
import { publish, stagePublication } from "./publication";

export function rejected(
  code: WeaverErrorCode,
): ConfigurationServiceWriteResult {
  return {
    success: false,
    outcome: "rejected",
    error: errorData(code, "Configuration write rejected"),
  };
}
export function rejection(error: unknown): ConfigurationServiceWriteResult {
  return rejected(
    error instanceof WeaverErrorInstance &&
      error.code !== "WRITE_OUTCOME_UNKNOWN"
      ? error.code
      : "VALIDATION_ERROR",
  );
}
export function fenceWrites(
  state: RootState,
  target: LoadedContribution,
): void {
  state.writeFence = Object.freeze([
    ...new Set([
      ...(state.writeFence ?? []),
      target.selection.captured.binding.id,
    ]),
  ]);
}
export function checkWriteStability(state: RootState): void {
  state.factory.assertRegistryStable();
  const config = state.factory.host.authConfig;
  if (config)
    validateAuthLayers(
      config,
      state.factory.options.layers.map((slot) => slot.layer),
    );
}
function observeStability(state: RootState, target: LoadedContribution): void {
  try {
    checkWriteStability(state);
  } catch {
    fenceWrites(state, target);
  }
}
export async function dispatchWrite(
  state: RootState,
  ticket: WriteTicket,
  target: LoadedContribution,
  writer: CapturedWriter,
): Promise<"committed" | "rejected" | "unknown"> {
  try {
    const output = await (ticket.operation === "set"
      ? writer.write(ticket.key, ticket.value)
      : writer.remove(ticket.key));
    observeStability(state, target);
    const copied = captureServiceData(output);
    const parsed = copied.success
      ? writeResultSchema.safeParse(copied.value)
      : undefined;
    if (
      !parsed?.success ||
      (parsed.data.success && parsed.data.error !== undefined)
    )
      return "unknown";
    if (!parsed.data.success)
      return writer.declaration.failureSemantics === "rejected-means-no-effect"
        ? "rejected"
        : "unknown";
    if (writer.flush) {
      const flushed = await writer.flush();
      observeStability(state, target);
      if (flushed !== undefined) return "unknown";
    }
    return "committed";
  } catch {
    observeStability(state, target);
    return "unknown";
  }
}
export async function reconcileUnknown(
  state: RootState,
  ticket: WriteTicket,
  target: LoadedContribution,
): Promise<ConfigurationServiceWriteResult> {
  fenceWrites(state, target);
  try {
    const [observed] = await loadContributions(
      [target.selection],
      ticket.request.identity,
    );
    if (observed?.layer && !observed.failed) {
      checkWriteStability(state);
      const plan = stagePublication(
        state,
        ticket,
        target,
        observed.layer.entries,
      );
      checkWriteStability(state);
      publish(state, plan);
    }
  } catch {
    /* Failed observation leaves every last-confirmed generation intact. */
  }
  return {
    success: false,
    outcome: "unknown",
    error: errorData(
      "WRITE_OUTCOME_UNKNOWN",
      "Configuration write outcome is unknown",
    ),
  };
}
