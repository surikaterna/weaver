import type { OverrideSessionController } from "@weaver-conf/config-sessions";
import {
  type ConfigurationReaderSelection,
  type ConfigurationSessionInfo,
  configurationSessionInfoSchema,
  createWeaverError,
  type SessionAuthorizationRequest,
} from "@weaver-conf/config-types";
import type { LoadedContribution } from "../hydration";
import type { SelectedBinding } from "../layer-stack";
import { captureBinding } from "../provider-binding";
import type { CapturedWriter } from "./provider-write";
import { captureWriters } from "./provider-write";

/** References and immutable confinement only. Domain owns metadata/entries/lease. */
export interface SessionReference {
  readonly controller: OverrideSessionController;
  readonly owner: unknown;
  readonly ownerCheck: () => void;
  readonly target: ConfigurationReaderSelection;
  readonly emergency: boolean;
  readonly selection: SelectedBinding;
  readonly writer: CapturedWriter;
  readonly auditRemoval: (
    info: ConfigurationSessionInfo,
    cause: SessionRemovalCause,
  ) => Promise<void>;
}

export type SessionRemovalCause = NonNullable<
  Extract<
    SessionAuthorizationRequest,
    { operation: "session-deactivate" }
  >["cause"]
>;

export function bindSession(
  controller: OverrideSessionController,
  target: ConfigurationReaderSelection,
  rank: number,
): Pick<SessionReference, "selection" | "writer"> {
  const provider = controller.provider;
  const captured = captureBinding({
    id: provider.id,
    layer: provider.layer,
    provider,
    environment: {
      kind: "environments",
      environments: [target.identity.environment],
    },
    operation: { kind: "load" },
    ownership: { kind: "borrowed" },
  });
  const writer = captureWriters(
    [captured],
    [
      {
        providerId: provider.id,
        operation: { kind: "write" },
        flush: "none",
        failureSemantics: "rejected-means-no-effect",
      },
    ],
    target.identity,
  ).get(captured);
  if (!writer)
    throw createWeaverError(
      "INTERNAL_ERROR",
      "Session writer capture invariant",
    );
  return { selection: { captured, rank, kind: "session" }, writer };
}

export function sessionContribution(ref: SessionReference): LoadedContribution {
  return {
    selection: ref.selection,
    failed: false,
    layer: {
      layer: ref.selection.captured.binding.layer,
      providerId: ref.selection.captured.binding.id,
      rank: ref.selection.rank,
      entries: ref.controller.getSession()?.overrides ?? {},
    },
  };
}

export function sessionInfo(
  ref: SessionReference,
): ConfigurationSessionInfo | null {
  if (!ref.controller.isActive()) return null;
  return sessionMetadata(ref);
}

export function sessionMetadata(
  ref: SessionReference,
): ConfigurationSessionInfo | null {
  const meta = ref.controller.getSession();
  if (!meta) return null;
  return configurationSessionInfoSchema.parse({
    ...ref.target,
    id: meta.id,
    layer: ref.selection.captured.binding.layer,
    activatedBy: meta.activatedBy,
    reason: meta.reason,
    activatedAt: Date.parse(meta.activatedAt),
    expiresAt: Date.parse(meta.expiresAt),
    followUpDeadline: Date.parse(meta.activatedAt) + 86400000,
    emergency: ref.emergency,
  });
}
