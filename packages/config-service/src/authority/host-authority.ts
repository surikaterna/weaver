import { withAuth } from "@weaver-conf/config-auth";
import {
  type ConfigurationAuthorityController,
  type ConfigurationServiceIdentity,
  createWeaverError,
} from "@weaver-conf/config-types";
import { createConfigurationReader } from "../configuration-reader";
import { assertLive, type RootState } from "../root-state";
import { createReadCheck } from "./authority-read";
import { createCapabilityRegistry } from "./capability-registry";
import { createMutationAuthority } from "./governed-write";
import { createSchemaAuthority } from "./schema-authority";

type Prepare = (
  identity: ConfigurationServiceIdentity,
  guard: () => void,
) => Promise<void>;

export function createHostAuthority(state: RootState, prepare: Prepare) {
  const host = state.factory.host;
  const registry = createCapabilityRegistry(
    () => assertLive(state),
    host.now ?? Date.now,
  );
  const auth = withAuth(host.authConfig);
  const execution = {
    state,
    registry,
    prepare,
    check: createReadCheck(state, registry, auth),
  };
  const controller = Object.freeze<ConfigurationAuthorityController>({
    mint: registry.mint,
    revoke: registry.revoke,
    replace(token, snapshot) {
      registry.revoke(token);
      return registry.mint(snapshot);
    },
    forMutations: (token) =>
      createMutationAuthority(state, registry, auth, token),
    forSchemas: (token) => createSchemaAuthority(state, registry, token),
    forIdentity: (token, selection) =>
      createConfigurationReader(execution, token, selection),
  });
  return { controller };
}

export function announceAuthority(state: RootState): void {
  if (!state.authority) return;
  try {
    const result: unknown = state.factory.host.onAuthorityReady(
      state.authority.controller,
    );
    if (result instanceof Promise) {
      void Promise.prototype.then.call(result, undefined, () => {});
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Authority callback must be synchronous",
      );
    }
  } catch {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Authority initialization failed",
    );
  }
}
