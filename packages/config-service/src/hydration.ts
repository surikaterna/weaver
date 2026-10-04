import type { ResolutionLayer } from "@weaver-conf/config-engine";
import {
  type ConfigurationServiceIdentity,
  createWeaverError,
} from "@weaver-conf/config-types";
import { z } from "zod";
import type { SelectedBinding } from "./layer-stack";
import { copyData } from "./snapshot-copy";

const data = z.strictObject({
  entries: z.custom<Readonly<Record<string, unknown>>>(
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value),
  ),
  revision: z.string().optional(),
  lastSyncedAt: z.number().optional(),
});
export interface LoadedContribution {
  readonly selection: SelectedBinding;
  readonly layer?: ResolutionLayer;
  readonly failed: boolean;
}

async function load(
  selection: SelectedBinding,
  identity: ConfigurationServiceIdentity,
): Promise<LoadedContribution> {
  try {
    const loaded = data.parse(
      copyData(await selection.captured.load(identity)),
    );
    const { binding } = selection.captured;
    return {
      selection,
      failed: false,
      layer: Object.freeze({
        layer: binding.layer,
        providerId: binding.id,
        rank: selection.rank,
        entries: loaded.entries,
      }),
    };
  } catch {
    return { selection, failed: true };
  }
}
export async function loadContributions(
  selected: readonly SelectedBinding[],
  identity: ConfigurationServiceIdentity,
): Promise<readonly LoadedContribution[]> {
  return Promise.all(selected.map((selection) => load(selection, identity)));
}
export function requireHealthy(
  contributions: readonly LoadedContribution[],
  failureMode: "fail" | "allow-degraded" | undefined,
): readonly string[] {
  const failed = Object.freeze(
    contributions
      .filter((item) => item.failed)
      .map((item) => item.selection.captured.binding.id),
  );
  if (failed.length && failureMode !== "allow-degraded")
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Configuration hydration failed",
      {
        degradedProviders: failed,
      },
    );
  return failed;
}
