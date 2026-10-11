import type { RegistryProjectionReader } from "@weaver-conf/config-registry";
import type { PreparedRegistration } from "@weaver-conf/config-registry/internal/server-adapter";
import { serializeRegistry } from "@weaver-conf/config-registry/persistence";
import {
  createWeaverError,
  schemaOperationResultSchema,
} from "@weaver-conf/config-types";
import { validateRegistryCeilings } from "../ceiling-validation";
import { stageIdentity } from "../identity-snapshots";
import { captureResolutionContext } from "../resolution-context";
import { publicationRestart } from "../restart-state";
import type { RootState } from "../root-state";
import { stageViews } from "../view-snapshots";
import { publish } from "./publication";
import {
  replaceRegistryContribution,
  stageRegistryStorage,
} from "./registry-storage";

export function schemaRevision(state: RootState): string {
  return `${state.incarnation}schema:${String(state.factory.adapter.revision)}`;
}

export function stageSchemaPublication(
  state: RootState,
  prepared: PreparedRegistration,
) {
  const { candidate, preview, result } = prepared;
  if (!candidate || !preview || !result.success || !result.metadata)
    throw createWeaverError("VALIDATION_ERROR", "Invalid registry candidate");
  validateRegistryCeilings(
    preview,
    state.factory.options.layers.map((slot) => slot.layer),
  );
  const payload = serializeRegistry(candidate);
  const storage = stageRegistryStorage(state, payload);
  const generation = state.generation + 1;
  const ready = stageSchemaIdentities(state, preview, storage, generation);
  const fixed = replaceRegistryContribution(state.fixed, storage);
  const views = stageViews(state.views, ready, preview, false);
  const success = schemaSuccess(state, result);
  const plan = {
    ready,
    views,
    fixed,
    generation,
    revision: `${state.incarnation}${String(generation)}`,
  };
  const restart = publicationRestart(state, plan);
  return {
    storage,
    success,
    publish() {
      prepared.publish();
      publish(state, { ...plan, restart }, "schema");
    },
  };
}

function stageSchemaIdentities(
  state: RootState,
  preview: RegistryProjectionReader,
  storage: ReturnType<typeof stageRegistryStorage>,
  generation: number,
) {
  const ready = new Map(state.ready);
  for (const [key, snapshot] of state.ready) {
    const context = captureResolutionContext(
      state,
      snapshot.identity,
      preview,
      state.factory.adapter.revision + 1,
    );
    ready.set(
      key,
      stageIdentity(
        snapshot.identity,
        `${state.incarnation}${String(generation)}`,
        replaceRegistryContribution(snapshot.contributions, storage),
        context,
        state.factory.options.failureMode,
      ),
    );
  }
  return ready;
}

function schemaSuccess(
  state: RootState,
  result: PreparedRegistration["result"],
) {
  return schemaOperationResultSchema.parse({
    success: true,
    revision: `${state.incarnation}schema:${String(state.factory.adapter.revision + 1)}`,
    isNewSchema: result.isNewSchema,
    hasBreakingChanges: result.hasBreakingChanges,
    metadata: result.metadata,
    ...(result.breakingChanges === undefined
      ? {}
      : { breakingChanges: result.breakingChanges }),
  });
}
