import type { PreparedRegistration } from "@weaver-conf/config-registry/internal/server-adapter";
import { serializeRegistry } from "@weaver-conf/config-registry/persistence";
import {
  createWeaverError,
  schemaOperationResultSchema,
} from "@weaver-conf/config-types";
import { stageIdentity } from "../identity-snapshots";
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
  const payload = serializeRegistry(candidate);
  const storage = stageRegistryStorage(state, payload);
  const ready = new Map(state.ready);
  const generation = state.generation + 1;
  const ranks = state.factory.options.layers.map((_, rank) => rank);
  for (const [key, snapshot] of state.ready)
    ready.set(
      key,
      stageIdentity(
        snapshot.identity,
        `${state.incarnation}${String(generation)}`,
        replaceRegistryContribution(snapshot.contributions, storage),
        preview,
        ranks,
        state.factory.options.failureMode,
        state.factory.adapter.revision + 1,
      ),
    );
  const fixed = replaceRegistryContribution(state.fixed, storage);
  const views = stageViews(state.views, ready, preview, false);
  const success = schemaSuccess(state, result);
  return {
    storage,
    success,
    publish() {
      prepared.publish();
      publish(
        state,
        {
          ready,
          views,
          fixed,
          generation,
          revision: `${state.incarnation}${String(generation)}`,
        },
        "schema",
      );
    },
  };
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
