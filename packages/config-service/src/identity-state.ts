import {
  type ConfigurationServiceIdentity,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { IdentitySnapshot } from "./identity-snapshots";
import { identityKey } from "./layer-stack";
import { assertLive, type RootState } from "./root-state";

/** Readers retain a tuple, not the generation that happened to create them. */
export function currentIdentity(
  state: RootState,
  identity: ConfigurationServiceIdentity,
): IdentitySnapshot {
  assertLive(state);
  const snapshot = state.ready.get(identityKey(identity));
  if (!snapshot)
    throw createWeaverError("SCOPE_NOT_LOADED", "Scope identity is not loaded");
  return snapshot;
}
