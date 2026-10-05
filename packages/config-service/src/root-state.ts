import {
  createWeaverError,
  type Result,
  type WeaverError,
} from "@weaver-conf/config-types";
import { validateAuthLayers } from "./authority/authority-contract-capture";
import type { createHostAuthority } from "./authority/host-authority";
import type { validateFactory } from "./factory-validation";
import type { LoadedContribution } from "./hydration";
import type { IdentitySnapshot } from "./identity-snapshots";
import type { createOperationQueue } from "./operation-queue";
import type { Resource } from "./resource-ownership";
import type { createServiceEvents } from "./service-events";

export interface RootState {
  readonly factory: ReturnType<typeof validateFactory>;
  ready: Map<string, IdentitySnapshot>;
  readonly pending: Map<string, Promise<void>>;
  readonly providers: readonly Resource[];
  readonly events: ReturnType<typeof createServiceEvents>;
  fixed: readonly LoadedContribution[];
  readonly queue: ReturnType<typeof createOperationQueue>;
  readonly incarnation: string;
  authority?: ReturnType<typeof createHostAuthority>;
  disposed: boolean;
  writeHookActive?: boolean;
  writeFence?: readonly string[];
  generation: number;
  disposal?: Promise<Result<undefined, WeaverError>>;
}

export function assertLive(state: RootState): void {
  if (state.disposed)
    throw createWeaverError("DISPOSED", "Configuration service is disposed");
  state.factory.assertRegistryStable();
  if (state.factory.host.authConfig)
    validateAuthLayers(
      state.factory.host.authConfig,
      state.factory.options.layers.map((slot) => slot.layer),
    );
}
