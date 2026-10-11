import {
  createWeaverError,
  type Result,
  type WeaverError,
} from "@weaver-conf/config-types";
import { validateAuthLayers } from "./authority/authority-contract-capture";
import type { createHostAuthority } from "./authority/host-authority";
import type { SessionReference } from "./authority/session-bindings";
import type { validateFactory } from "./factory-validation";
import type { LoadedContribution } from "./hydration";
import type { PendingIdentity } from "./identity-hydration";
import type { IdentitySnapshot } from "./identity-snapshots";
import type { createOperationQueue } from "./operation-queue";
import type { Resource } from "./resource-ownership";
import type { createServiceEvents } from "./service-events";
import type { PreparedView } from "./view-snapshots";

export interface RootState {
  readonly factory: ReturnType<typeof validateFactory>;
  readonly sessions: Map<string, SessionReference>;
  ready: Map<string, IdentitySnapshot>;
  views: Map<string, PreparedView>;
  readonly pending: Map<string, PendingIdentity>;
  readonly providers: readonly Resource[];
  readonly events: ReturnType<typeof createServiceEvents>;
  fixed: readonly LoadedContribution[];
  readonly queue: ReturnType<typeof createOperationQueue>;
  readonly incarnation: string;
  authority?: ReturnType<typeof createHostAuthority>;
  disposed: boolean;
  writeHookActive?: boolean;
  writeFence?: readonly string[];
  schemaFence?: readonly string[];
  reloadFailures?: readonly string[];
  restartPending?: "hot" | "rolling-restart" | "restart-required";
  stopWatching?: () => Promise<readonly string[]>;
  generation: number;
  disposal?: Promise<Result<undefined, WeaverError>>;
}

export function assertNotDisposed(state: RootState): void {
  if (state.disposed)
    throw createWeaverError("DISPOSED", "Configuration service is disposed");
}

export function assertLive(state: RootState): void {
  assertNotDisposed(state);
  if (state.factory.host.authConfig)
    validateAuthLayers(
      state.factory.host.authConfig,
      state.factory.options.layers.map((slot) => slot.layer),
    );
}

export function assertReadable(state: RootState): void {
  assertLive(state);
  if (state.schemaFence)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Registry recovery requires a new root",
    );
}
